import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hookPath = join(pluginRoot, 'scripts', 'capture-tool-use.mjs')

function writeState(workdir, overrides = {}) {
  const { writeLoopStart = true, ...stateOverrides } = overrides
  const state = {
    iteration: 2,
    max_iterations: 5,
    session_id: 'session-123',
    clone_threshold: 0.6,
    clone_agent: 'Claude Code Clone Loop',
    clone_session_id: '',
    mcp_session_id: '',
    last_prompt_event_id: '',
    started_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    prompt: 'Ship the feature.',
    ...stateOverrides,
  }
  const optionalLines = []
  if (state.clone_session_id) optionalLines.push(`clone_session_id: "${state.clone_session_id}"`)
  if (state.mcp_session_id) optionalLines.push(`mcp_session_id: "${state.mcp_session_id}"`)
  if (state.last_prompt_event_id) optionalLines.push(`last_prompt_event_id: "${state.last_prompt_event_id}"`)

  mkdirSync(join(workdir, '.claude'), { recursive: true })
  writeFileSync(
    join(workdir, '.claude', 'clone-loop.local.md'),
    `---
iteration: ${state.iteration}
max_iterations: ${state.max_iterations}
session_id: ${state.session_id}
clone_threshold: ${state.clone_threshold}
clone_agent: "${state.clone_agent}"
started_at: "${state.started_at}"
${optionalLines.join('\n')}
---
${state.prompt}
`,
  )
  if (writeLoopStart) {
    writeFileSync(
      join(workdir, '.claude', 'clone-loop.history.local.jsonl'),
      `${JSON.stringify({
        ts: state.started_at,
        event: 'loop-start',
        session_id: state.session_id,
        max_iterations: Number(state.max_iterations),
        clone_threshold: Number(state.clone_threshold),
        clone_agent: state.clone_agent,
        prompt: state.prompt,
      })}\n`,
    )
  }
}

function runHook(workdir, payload) {
  return spawnSync(process.execPath, [hookPath], {
    cwd: workdir,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
}

function runHookAsync(workdir, payload, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd: workdir,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLONE_API_TOKEN: 'test-token',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolveRun({ status, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

function readHistory(workdir) {
  const history = readFileSync(join(workdir, '.claude', 'clone-loop.history.local.jsonl'), 'utf8')
  return history
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('PostToolUse capture hook', () => {
  it('records file mutation tool use during an active Clone Loop', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-post-tool-'))

    try {
      writeState(workdir)

      const result = runHook(workdir, {
        session_id: 'session-123',
        tool_name: 'Write',
        tool_input: {
          file_path: 'src/app.js',
          content: 'x'.repeat(400),
        },
        tool_response: {
          success: true,
        },
      })

      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, '')

      const record = readHistory(workdir).find((entry) => entry.event === 'post-tool-use')
      assert.ok(record)
      assert.equal(record.event, 'post-tool-use')
      assert.equal(record.iteration, 2)
      assert.equal(record.tool_name, 'Write')
      assert.equal(record.file_path, 'src/app.js')
      assert.equal(record.success, true)
      assert.match(record.summary, /Write src\/app\.js/)
      assert.doesNotMatch(JSON.stringify(record), /xxxxxxxxxxxxxxxxxxxxxxxx/)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('records mutation summaries to the active Clone MCP session', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-post-tool-mcp-'))

    try {
      writeState(workdir, {
        clone_session_id: 'clone-session-tool',
        mcp_session_id: 'mcp-session-tool',
        last_prompt_event_id: 'prompt-event-tool',
      })

      const calls = []
      const server = createServer(async (req, res) => {
        let body = ''
        req.setEncoding('utf8')
        for await (const chunk of req) body += chunk
        const payload = JSON.parse(body)
        calls.push({ method: payload.method, params: payload.params, headers: req.headers })
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream')
        res.end(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ event_id: 'tool-response-event' }) }],
            },
          })}\n\n`,
        )
      })
      await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const { port } = server.address()
      try {
        const result = await runHookAsync(
          workdir,
          {
            session_id: 'session-123',
            tool_name: 'Edit',
            tool_input: { file_path: 'src/app.js' },
            tool_response: { success: true, message: 'edited file' },
          },
          { CLONE_MCP_URL: `http://127.0.0.1:${port}/mcp` },
        )

        assert.equal(result.status, 0, JSON.stringify(result))
        const recordCall = calls.find((call) => call.params?.name === 'record_agent_response')
        assert.ok(recordCall)
        assert.equal(recordCall.params.arguments.session_id, 'clone-session-tool')
        assert.equal(recordCall.params.arguments.in_response_to, 'prompt-event-tool')
        assert.equal(recordCall.params.arguments.source, 'tool-use')
        assert.match(recordCall.params.arguments.response, /Tool use: Edit src\/app\.js/)

        const history = readHistory(workdir)
        assert.equal(history.some((entry) => entry.event === 'record-response' && entry.source === 'post-tool-use'), true)
      } finally {
        await new Promise((resolveClose) => server.close(resolveClose))
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('stays silent when no Clone Loop is active or the session differs', () => {
    const inactiveDir = mkdtempSync(join(tmpdir(), 'clone-post-tool-inactive-'))
    const mismatchDir = mkdtempSync(join(tmpdir(), 'clone-post-tool-mismatch-'))

    try {
      const inactive = runHook(inactiveDir, {
        session_id: 'session-123',
        tool_name: 'Edit',
        tool_input: { file_path: 'README.md' },
      })
      assert.equal(inactive.status, 0, inactive.stderr)
      assert.equal(inactive.stdout, '')
      assert.equal(existsSync(join(inactiveDir, '.claude', 'clone-loop.history.local.jsonl')), false)

      writeState(mismatchDir, { session_id: 'session-123' })
      const mismatch = runHook(mismatchDir, {
        session_id: 'different-session',
        tool_name: 'Edit',
        tool_input: { file_path: 'README.md' },
      })
      assert.equal(mismatch.status, 0, mismatch.stderr)
      assert.equal(mismatch.stdout, '')
      const mismatchHistory = readHistory(mismatchDir)
      assert.equal(mismatchHistory.some((entry) => entry.decision === 'stale-session-state'), true)
      assert.equal(existsSync(join(mismatchDir, '.claude', 'clone-loop.local.md')), false)
    } finally {
      rmSync(inactiveDir, { recursive: true, force: true })
      rmSync(mismatchDir, { recursive: true, force: true })
    }
  })

  it('does not capture tool use when loop-start is missing', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'clone-post-tool-stale-'))

    try {
      writeState(workdir, { writeLoopStart: false })

      const result = runHook(workdir, {
        session_id: 'session-123',
        tool_name: 'Write',
        tool_input: { file_path: 'README.md' },
        tool_response: { success: true },
      })

      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, '')
      const history = readHistory(workdir)
      assert.equal(history.some((entry) => entry.decision === 'stale-missing-loop-start'), true)
      assert.equal(history.some((entry) => entry.event === 'post-tool-use' && entry.tool_name === 'Write'), false)
      assert.equal(existsSync(join(workdir, '.claude', 'clone-loop.local.md')), false)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
