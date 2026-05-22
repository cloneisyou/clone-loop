import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hookPath = join(pluginRoot, 'hooks', 'ask-user-question-hook.mjs')

function writeState(workdir, overrides = {}) {
  const { writeLoopStart = true, ...stateOverrides } = overrides
  const state = {
    iteration: 1,
    max_iterations: 3,
    session_id: 'session-123',
    clone_threshold: 0.6,
    clone_agent: 'Claude Code Clone Loop',
    started_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    prompt: 'Fix the bug and run tests.',
    ...stateOverrides,
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

function runHook(workdir, endpoint, toolInput, options = {}) {
  return new Promise((resolveRun) => {
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLONE_MCP_URL: endpoint,
    }
    if (options.pluginDataDir) {
      env.CLAUDE_PLUGIN_DATA = options.pluginDataDir
    } else {
      delete env.CLAUDE_PLUGIN_DATA
    }
    if (Object.hasOwn(options, 'cloneApiToken')) {
      env.CLONE_API_TOKEN = options.cloneApiToken
    } else if (options.withToken !== false) {
      env.CLONE_API_TOKEN = options.token || 'test-token'
    } else {
      delete env.CLONE_API_TOKEN
    }

    const child = spawn(process.execPath, [hookPath], {
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
        session_id: options.sessionId || 'session-123',
        tool_name: 'AskUserQuestion',
        tool_input: toolInput,
      }),
    )
  })
}

async function withMcpServer(predictions, callback) {
  const calls = []
  const queue = Array.isArray(predictions) ? [...predictions] : [predictions]
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
    const prediction = queue.shift()
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

async function withFailingMcpServer(callback) {
  const calls = []
  const server = createServer(async (req, res) => {
    let body = ''
    req.setEncoding('utf8')
    for await (const chunk of req) body += chunk
    calls.push(JSON.parse(body))

    res.statusCode = 500
    res.end('synthetic Clone MCP failure')
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  try {
    return await callback(`http://127.0.0.1:${port}/mcp`, calls)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

describe('AskUserQuestion PreToolUse hook', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'clone-loop-question-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('answers with Clone free-form predicted response even when it is not an option label', async () => {
    writeState(workdir)

    const toolInput = {
      questions: [
        {
          question: 'What should we do next?',
          header: 'Next step',
          options: [{ label: 'Run tests' }, { label: 'Open a PR' }],
        },
      ],
    }

    await withMcpServer(
      {
        id: 'question-prediction-1',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'Run the focused tests first, then open a PR if green.',
        confidence: 0.91,
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, toolInput)

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        assert.deepEqual(
          calls.map((call) => call.method),
          ['initialize', 'tools/call'],
        )
        assert.equal(calls[1].params.name, 'predict_next_prompt')
        assert.match(calls[1].params.arguments.agent_input, /What should we do next\?/)
        assert.match(calls[1].params.arguments.agent_input, /Run tests/)
        assert.equal(calls[1].params.arguments.threshold, 0.6)
        assert.equal(calls[1].params.arguments.k, 1)

        const output = JSON.parse(result.stdout)
        assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse')
        assert.equal(output.hookSpecificOutput.permissionDecision, 'allow')
        assert.match(output.hookSpecificOutput.permissionDecisionReason, /predicted response/)
        assert.deepEqual(output.hookSpecificOutput.updatedInput, {
          questions: toolInput.questions,
          answers: {
            'What should we do next?': 'Run the focused tests first, then open a PR if green.',
          },
        })
      },
    )
  })

  it('does not answer when no Clone Loop is active', async () => {
    await withMcpServer(
      {
        id: 'unused',
        status: 'auto',
        predicted_response: 'Run tests',
        confidence: 0.99,
      },
      async (endpoint, calls) => {
        const result = await runHook(
          workdir,
          endpoint,
          {
            questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }],
          },
        )

        assert.equal(result.status, 0)
        assert.equal(result.stdout, '')
        assert.deepEqual(calls, [])
      },
    )
  })

  it('does not answer when confidence is below threshold or status is not auto', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'question-prediction-2-low',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'I would run the focused tests before opening a PR.',
        confidence: 0.42,
      },
      async (endpoint) => {
        const result = await runHook(workdir, endpoint, {
          questions: [{ question: 'Continue?', options: [{ label: 'Run tests' }, { label: 'Open PR' }] }],
        })

        assert.equal(result.status, 0)
        assert.equal(result.stdout, '')
        const history = readFileSync(join(workdir, '.claude', 'clone-loop.history.local.jsonl'), 'utf8')
        assert.match(history, /"decision":"defer-low-confidence"/)
        assert.ok(readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8'))
      },
    )

    writeState(workdir)

    await withMcpServer(
      {
        id: 'question-prediction-2-escalated',
        status: 'escalated',
        threshold: 0.6,
        predicted_response: 'Open a PR.',
        confidence: 0.91,
      },
      async (endpoint) => {
        const result = await runHook(workdir, endpoint, {
          questions: [{ question: 'Continue?', options: [{ label: 'Run tests' }, { label: 'Open PR' }] }],
        })

        assert.equal(result.status, 0)
        assert.equal(result.stdout, '')
        const history = readFileSync(join(workdir, '.claude', 'clone-loop.history.local.jsonl'), 'utf8')
        assert.match(history, /"decision":"defer-non-auto"/)
        assert.ok(readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8'))
      },
    )
  })

  it('falls back to the highest-confidence mapped candidate when no free-form prediction is returned', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'question-prediction-3',
        status: 'auto',
        threshold: 0.6,
        confidence: 0.9,
        candidates: [
          { predicted_response: 'Default fast path', confidence: 0.62 },
          { predicted_response: 'Default safe path', confidence: 0.83 },
          { predicted_response: 'Use the default option', confidence: 0.9 },
        ],
      },
      async (endpoint) => {
        const result = await runHook(workdir, endpoint, {
          questions: [
            {
              question: 'Which option?',
              options: [{ label: 'Default fast path' }, { label: 'Default safe path' }],
            },
          ],
        })

        assert.equal(result.status, 0)
        const output = JSON.parse(result.stdout)
        assert.equal(output.hookSpecificOutput.updatedInput.answers['Which option?'], 'Default safe path')
      },
    )
  })

  it('defers when neither free-form nor mapped candidate is available', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'question-prediction-4',
        status: 'auto',
        threshold: 0.6,
        confidence: 0.91,
        candidates: [
          { predicted_response: 'Use the default option', confidence: 0.91 },
          { predicted_response: 'Whatever is safest', confidence: 0.88 },
        ],
      },
      async (endpoint) => {
        const result = await runHook(workdir, endpoint, {
          questions: [
            {
              question: 'Which option?',
              options: [{ label: 'Default fast path' }, { label: 'Default safe path' }],
            },
          ],
        })

        assert.equal(result.status, 0)
        assert.equal(result.stdout, '')
        const history = readFileSync(join(workdir, '.claude', 'clone-loop.history.local.jsonl'), 'utf8')
        assert.match(history, /"decision":"defer-unmapped"/)
        assert.ok(readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8'))
      },
    )
  })

  it('defers instead of choosing the first option when Clone MCP fails', async () => {
    writeState(workdir)

    await withFailingMcpServer(async (endpoint) => {
      const result = await runHook(workdir, endpoint, {
        questions: [
          {
            question: 'Which option?',
            options: [{ label: 'Run focused tests' }, { label: 'Open a PR' }, { label: 'Stop now' }],
          },
        ],
      })

      assert.equal(result.status, 0)
      assert.equal(result.stdout, '')
      const history = readFileSync(join(workdir, '.claude', 'clone-loop.history.local.jsonl'), 'utf8')
      assert.match(history, /"decision":"defer-mcp-error"/)
      assert.ok(readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8'))
    })
  })

  it('includes prior Clone-injected user turns in the agent_input history', async () => {
    writeState(workdir)
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    writeFileSync(
      join(workdir, '.claude', 'clone-loop.history.local.jsonl'),
      [
        JSON.stringify({
          ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          event: 'loop-start',
          session_id: 'session-123',
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:01Z',
          event: 'stop',
          decision: 'continue',
          iteration: 1,
          confidence: 0.9,
          threshold: 0.6,
          prediction_id: 'p-1',
          status: 'auto',
          predicted_response: 'Run lint after the tests pass.',
        }),
      ].join('\n') + '\n',
    )

    const toolInput = {
      questions: [
        {
          question: 'Which option?',
          options: [{ label: 'Run focused tests' }, { label: 'Open a PR' }],
        },
      ],
    }

    await withMcpServer(
      {
        id: 'question-prediction-history',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'Run focused tests',
        confidence: 0.91,
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, toolInput)

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        const agentInput = calls[1].params.arguments.agent_input
        assert.match(agentInput, /### user \(clone-prediction\):/)
        assert.match(agentInput, /Run lint after the tests pass\./)
        assert.match(agentInput, /Which option\?/)
        assert.match(agentInput, /Run focused tests/)
        assert.match(agentInput, /Open a PR/)
      },
    )
  })

  it('does not auto-answer and removes stale state when loop-start is missing', async () => {
    writeState(workdir, { writeLoopStart: false })

    await withMcpServer(
      {
        id: 'question-stale-state',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'Run focused tests',
        confidence: 0.99,
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, {
          questions: [
            {
              question: 'Which option?',
              options: [{ label: 'Run focused tests' }, { label: 'Open a PR' }],
            },
          ],
        })

        assert.equal(result.status, 0)
        assert.equal(result.stdout, '')
        assert.equal(calls.length, 0)
        assert.throws(() => readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8'))
      },
    )
  })

})
