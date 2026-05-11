import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const launcherPath = join(pluginRoot, 'scripts', 'run-plugin-bash.mjs')

function writeState(workdir, overrides = {}) {
  const state = {
    iteration: 0,
    max_iterations: 3,
    completion_promise: 'DONE',
    session_id: 'session-123',
    clone_threshold: 0.8,
    clone_k: 1,
    clone_agent: 'Claude Code Clone Loop',
    prompt: 'Fix the bug and run tests.',
    ...overrides,
  }

  mkdirSync(join(workdir, '.claude'), { recursive: true })
  writeFileSync(
    join(workdir, '.claude', 'clone-loop.local.md'),
    `---
iteration: ${state.iteration}
max_iterations: ${state.max_iterations}
completion_promise: "${state.completion_promise}"
session_id: ${state.session_id}
clone_threshold: ${state.clone_threshold}
clone_k: ${state.clone_k}
clone_agent: "${state.clone_agent}"
---
${state.prompt}
`,
  )
}

function runHook(workdir, endpoint, options = {}) {
  return new Promise((resolveRun) => {
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLONE_MCP_URL: endpoint,
    }
    if (options.withToken !== false) {
      env.CLONE_API_TOKEN = 'test-token'
    } else {
      delete env.CLONE_API_TOKEN
    }

    const child = spawn(process.execPath, [launcherPath, 'hooks/stop-hook.sh'], {
      cwd: workdir,
      env,
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
      resolveRun({ status: null, signal: 'timeout', stdout, stderr, error: new Error('hook timed out') })
    }, 10000)

    child.on('close', (status, signal) => {
      clearTimeout(timeout)
      resolveRun({ status, signal, stdout, stderr })
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolveRun({ status: null, signal: null, stdout, stderr, error })
    })

    child.stdin.end(
      JSON.stringify({
        session_id: 'session-123',
        last_assistant_message: 'Tests passed. What next?',
      }),
    )
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
      res.end(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: { serverInfo: { name: 'clone', version: 'test' }, capabilities: {} },
        })}\n\n`,
      )
      return
    }

    assert.equal(payload.method, 'tools/call')
    assert.equal(req.headers['mcp-session-id'], 'mcp-session-123')
    res.end(
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(prediction) }],
        },
      })}\n\n`,
    )
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  try {
    return await callback(`http://127.0.0.1:${port}/mcp`, calls)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

describe('Clone Loop v2 stop hook', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'clone-loop-v2-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('calls Clone MCP directly and injects a confident predicted prompt', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'prediction-1',
        status: 'auto',
        threshold: 0.8,
        predicted_response: 'Commit this and move on.',
        confidence: 0.91,
        reasoning: 'The user usually commits after green tests.',
        candidates: [],
        k: 1,
        model: 'test-model',
        latency_ms: 12,
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint)

        assert.equal(
          result.status,
          0,
          JSON.stringify(
            { error: result.error?.message, signal: result.signal, stdout: result.stdout, stderr: result.stderr, calls },
            null,
            2,
          ),
        )
        assert.deepEqual(
          calls.map((call) => call.method),
          ['initialize', 'tools/call'],
        )
        assert.equal(calls[1].params.name, 'predict_next_prompt')
        assert.equal(calls[1].params.arguments.agent, 'Claude Code Clone Loop')
        assert.match(calls[1].params.arguments.agent_input, /Fix the bug and run tests/)
        assert.match(calls[1].params.arguments.agent_input, /Tests passed\. What next\?/)
        assert.equal(calls[1].params.arguments.threshold, 0.8)
        assert.equal(calls[1].params.arguments.session_id, 'session-123')

        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'block')
        assert.match(output.reason, /Commit this and move on\./)
        assert.match(output.reason, /confidence 0\.91/)
        assert.doesNotMatch(output.reason, /mcp__clone__predict_next_prompt/)

        const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
        assert.match(state, /iteration: 1/)
      },
    )
  })

  it('removes loop state and escalates when Clone confidence is low', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'prediction-2',
        status: 'escalated',
        threshold: 0.8,
        predicted_response: 'Maybe run more tests?',
        confidence: 0.42,
        reasoning: 'Not enough matching memory.',
        candidates: [],
        k: 1,
        model: 'test-model',
        latency_ms: 10,
      },
      async (endpoint) => {
        const result = await runHook(workdir, endpoint)

        assert.equal(
          result.status,
          0,
          JSON.stringify(
            { error: result.error?.message, signal: result.signal, stdout: result.stdout, stderr: result.stderr },
            null,
            2,
          ),
        )
        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'block')
        assert.match(output.reason, /not confident enough/i)
        assert.throws(() => readFileSync(join(workdir, '.claude', 'clone-loop.local.md')))
      },
    )
  })

  it('uses the public demo Clone API key when CLONE_API_TOKEN is unset', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'prediction-3',
        status: 'auto',
        threshold: 0.8,
        predicted_response: 'Run one more check.',
        confidence: 0.9,
        reasoning: 'The user usually verifies before completion.',
        candidates: [],
        k: 1,
        model: 'test-model',
        latency_ms: 8,
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, { withToken: false })

        assert.equal(
          result.status,
          0,
          JSON.stringify(
            { error: result.error?.message, signal: result.signal, stdout: result.stdout, stderr: result.stderr, calls },
            null,
            2,
          ),
        )
        assert.equal(calls[0].headers['x-clone-api-key'], 'clone_yc-reviewer-public-demo-2026')
        assert.equal(calls[1].headers['x-clone-api-key'], 'clone_yc-reviewer-public-demo-2026')
      },
    )
  })
})
