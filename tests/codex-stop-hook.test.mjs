import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hookPath = join(pluginRoot, 'hooks', 'stop-hook.mjs')

function writeState(workdir, overrides = {}) {
  const state = {
    iteration: 1,
    max_iterations: 3,
    session_id: 'codex-session-123',
    clone_threshold: 0.6,
    clone_agent: 'Codex Clone Loop',
    started_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    prompt: 'Fix the Codex plugin and run tests.',
    ...overrides,
  }

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
---
${state.prompt}
`,
  )
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

function runHook(workdir, endpoint, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd: options.cwd || workdir,
      env: {
        ...process.env,
        PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: join(workdir, '.plugin-data'),
        CLONE_MCP_URL: endpoint,
        CLONE_API_TOKEN: 'test-token',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    const timeout = setTimeout(() => {
      child.kill()
      resolveRun({ status: null, signal: 'timeout', stdout, stderr })
    }, 10000)

    child.on('close', (status, signal) => {
      clearTimeout(timeout)
      resolveRun({ status, signal, stdout, stderr })
    })

    const payload = {
      hook_event_name: 'Stop',
      session_id: 'codex-session-123',
      cwd: workdir,
      stop_hook_active: options.stopHookActive || false,
      last_assistant_message: 'Tests are green. What next?',
    }
    if (options.transcriptPath) payload.transcript_path = options.transcriptPath
    child.stdin.end(JSON.stringify(payload))
  })
}

async function withMcpServer(prediction, callback) {
  const calls = []
  const server = createServer(async (req, res) => {
    let body = ''
    req.setEncoding('utf8')
    for await (const chunk of req) body += chunk
    const payload = JSON.parse(body)
    calls.push({ method: payload.method, params: payload.params, headers: req.headers })

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream')
    if (payload.method === 'initialize') {
      res.setHeader('mcp-session-id', 'mcp-session-123')
      res.end(`data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { serverInfo: { name: 'clone', version: 'test' }, capabilities: {} },
      })}\n\n`)
      return
    }

    res.end(`data: ${JSON.stringify({
      jsonrpc: '2.0',
      id: payload.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(prediction) }],
      },
    })}\n\n`)
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  try {
    return await callback(`http://127.0.0.1:${port}/mcp`, calls)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

describe('Codex Stop hook', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'clone-codex-stop-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('uses cwd from Codex hook input and injects a confident predicted prompt', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'prediction-codex-1',
        status: 'auto',
        predicted_response: 'Commit the Codex plugin changes.',
        confidence: 0.92,
        reasoning: 'The tests are green.',
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, { cwd: pluginRoot })

        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(calls.map((call) => call.method), ['initialize', 'tools/call'])
        assert.equal(calls[1].params.arguments.agent, 'Codex Clone Loop')
        assert.match(calls[1].params.arguments.agent_input, /Fix the Codex plugin/)
        assert.match(calls[1].params.arguments.agent_input, /Tests are green/)

        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'block')
        assert.match(output.reason, /Commit the Codex plugin changes\./)

        const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
        assert.match(state, /iteration: 2/)
      },
    )
  })

  it('includes Codex transcript response items in Clone agent input', async () => {
    writeState(workdir)
    const transcriptPath = join(workdir, 'codex-transcript.jsonl')
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I inspected the plugin manifest.' }],
          },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'apply_patch',
            arguments: JSON.stringify({ patch: '*** Update File: .codex-plugin/plugin.json' }),
          },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: 'Success. Updated files.',
          },
        }),
      ].join('\n'),
    )

    await withMcpServer(
      {
        id: 'prediction-codex-transcript',
        status: 'auto',
        predicted_response: 'Run the Codex plugin tests.',
        confidence: 0.88,
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, { transcriptPath })

        assert.equal(result.status, 0, result.stderr)
        const agentInput = calls[1].params.arguments.agent_input
        assert.match(agentInput, /I inspected the plugin manifest/)
        assert.match(agentInput, /\[tool_use\] apply_patch/)
        assert.match(agentInput, /\[tool_result apply_patch\]/)
        assert.match(agentInput, /Success\. Updated files/)
      },
    )
  })

  it('does not create recursive continuations when Codex reports stop_hook_active', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        predicted_response: 'This should not be used.',
        confidence: 1,
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, { stopHookActive: true })

        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout.trim(), '')
        assert.equal(calls.length, 0)
        const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
        assert.match(state, /iteration: 1/)
      },
    )
  })
})
