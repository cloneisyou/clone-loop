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
const ANSI_BOLD = '\u001b[1m'
const ANSI_PURPLE = '\u001b[35m'
const ANSI_RESET = '\u001b[0m'

function assertProminentPredictedPrompt(reason, iteration, predictedResponse) {
  assert.match(
    reason,
    new RegExp(escapeRegExp(`${ANSI_BOLD}${ANSI_PURPLE}Iteration ${iteration} : ${predictedResponse}${ANSI_RESET}`)),
  )
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function writeState(workdir, overrides = {}) {
  const state = {
    iteration: 1,
    max_iterations: 3,
    session_id: 'session-123',
    clone_threshold: 0.8,
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
session_id: ${state.session_id}
clone_threshold: ${state.clone_threshold}
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
    if (Object.hasOwn(options, 'cloneApiToken')) {
      env.CLONE_API_TOKEN = options.cloneApiToken
    } else {
      if (options.withToken !== false) {
        env.CLONE_API_TOKEN = options.token || 'test-token'
      } else {
        delete env.CLONE_API_TOKEN
      }
    }
    if (options.pluginDataDir) {
      env.CLAUDE_PLUGIN_DATA = options.pluginDataDir
    } else {
      delete env.CLAUDE_PLUGIN_DATA
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

    const stdinPayload = {
      session_id: options.sessionId || 'session-123',
    }
    if (Object.hasOwn(options, 'lastAssistantMessage')) {
      if (options.lastAssistantMessage) stdinPayload.last_assistant_message = options.lastAssistantMessage
    } else {
      stdinPayload.last_assistant_message = 'Tests passed. What next?'
    }
    if (options.transcriptPath) {
      stdinPayload.transcript_path = options.transcriptPath
    }
    child.stdin.end(JSON.stringify(stdinPayload))
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
        assertProminentPredictedPrompt(output.reason, 2, 'Commit this and move on.')
        assert.doesNotMatch(output.reason, /mcp__clone__predict_next_prompt/)

        const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
        assert.match(state, /iteration: 2/)
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
        assertProminentPredictedPrompt(output.reason, 2, 'Maybe run more tests?')
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

  it('uses the public demo Clone API key when CLONE_API_TOKEN is blank', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'prediction-blank-token',
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
        const result = await runHook(workdir, endpoint, { cloneApiToken: '   ' })

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

  it('uses a saved plugin API key when CLONE_API_TOKEN is unset', async () => {
    writeState(workdir)
    const pluginDataDir = mkdtempSync(join(tmpdir(), 'clone-plugin-data-'))
    writeFileSync(
      join(pluginDataDir, 'auth.local.json'),
      `${JSON.stringify({ clone_api_token: 'clone_saved_hook_token_1234567890' }, null, 2)}\n`,
    )

    try {
      await withMcpServer(
        {
          id: 'prediction-4',
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
          const result = await runHook(workdir, endpoint, {
            withToken: false,
            pluginDataDir,
          })

          assert.equal(
            result.status,
            0,
            JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2),
          )
          assert.equal(calls[0].headers['x-clone-api-key'], 'clone_saved_hook_token_1234567890')
          assert.equal(calls[1].headers['x-clone-api-key'], 'clone_saved_hook_token_1234567890')
        },
      )
    } finally {
      rmSync(pluginDataDir, { recursive: true, force: true })
    }
  })

  it('injects multi-turn history with previously predicted prompts', async () => {
    writeState(workdir)
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    const historyPath = join(workdir, '.claude', 'clone-loop.history.local.jsonl')
    writeFileSync(
      historyPath,
      [
        JSON.stringify({
          ts: '2026-01-01T00:00:01Z',
          event: 'stop',
          decision: 'continue',
          iteration: 1,
          confidence: 0.9,
          threshold: 0.8,
          prediction_id: 'p-1',
          status: 'auto',
          predicted_response: 'Run lint after the tests pass.',
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:05Z',
          event: 'stop',
          decision: 'continue',
          iteration: 2,
          confidence: 0.92,
          threshold: 0.8,
          prediction_id: 'p-2',
          status: 'auto',
          predicted_response: 'Now open a draft PR with the diff.',
        }),
      ].join('\n') + '\n',
    )

    await withMcpServer(
      {
        id: 'prediction-history-1',
        status: 'auto',
        threshold: 0.8,
        predicted_response: 'Continue.',
        confidence: 0.9,
        candidates: [],
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint)

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        const agentInput = calls[1].params.arguments.agent_input
        assert.match(agentInput, /Fix the bug and run tests/)
        assert.match(agentInput, /### user \(clone-prediction\):/)
        const firstIdx = agentInput.indexOf('Run lint after the tests pass.')
        const secondIdx = agentInput.indexOf('Now open a draft PR with the diff.')
        assert.notEqual(firstIdx, -1)
        assert.notEqual(secondIdx, -1)
        assert.ok(firstIdx < secondIdx, 'predicted prompts must appear in chronological order')
      },
    )
  })

  it('injects auto-answered questions into history', async () => {
    writeState(workdir)
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    const historyPath = join(workdir, '.claude', 'clone-loop.history.local.jsonl')
    writeFileSync(
      historyPath,
      JSON.stringify({
        ts: '2026-01-01T00:00:02Z',
        event: 'ask-user-question',
        decision: 'auto-answer-freeform',
        confidence: 0.91,
        threshold: 0.8,
        answers: { 'Should we open a PR?': 'Yes, open it as a draft.' },
      }) + '\n',
    )

    await withMcpServer(
      {
        id: 'prediction-history-2',
        status: 'auto',
        threshold: 0.8,
        predicted_response: 'Continue.',
        confidence: 0.9,
        candidates: [],
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint)

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        const agentInput = calls[1].params.arguments.agent_input
        assert.match(agentInput, /### user \(auto-answer\):/)
        assert.match(agentInput, /Q: Should we open a PR\?/)
        assert.match(agentInput, /A: Yes, open it as a draft\./)
      },
    )
  })

  it('truncates history to most recent N turns while preserving original prompt', async () => {
    writeState(workdir)
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    const historyPath = join(workdir, '.claude', 'clone-loop.history.local.jsonl')
    const lines = []
    for (let index = 1; index <= 30; index += 1) {
      lines.push(
        JSON.stringify({
          ts: `2026-01-01T00:${String(index).padStart(2, '0')}:00Z`,
          event: 'stop',
          decision: 'continue',
          iteration: index,
          confidence: 0.9,
          threshold: 0.8,
          prediction_id: `p-${index}`,
          status: 'auto',
          predicted_response: `Predicted prompt number ${index}.`,
        }),
      )
    }
    writeFileSync(historyPath, lines.join('\n') + '\n')

    await withMcpServer(
      {
        id: 'prediction-history-3',
        status: 'auto',
        threshold: 0.8,
        predicted_response: 'Continue.',
        confidence: 0.9,
        candidates: [],
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint)

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        const agentInput = calls[1].params.arguments.agent_input
        assert.match(agentInput, /Original Clone Loop prompt:/)
        assert.match(agentInput, /Fix the bug and run tests\./)

        // The current iteration assistant text counts toward the window. With
        // 30 user turns and 1 assistant turn, the cap of 20 keeps the latest
        // 19 user turns plus the assistant turn. Predictions 12..30 should
        // remain; 1..11 should be dropped.
        for (let index = 12; index <= 30; index += 1) {
          assert.match(
            agentInput,
            new RegExp(escapeRegExp(`Predicted prompt number ${index}.`)),
            `expected window to keep prediction ${index}`,
          )
        }
        for (let index = 1; index <= 11; index += 1) {
          assert.doesNotMatch(
            agentInput,
            new RegExp(escapeRegExp(`Predicted prompt number ${index}.`)),
            `expected window to drop prediction ${index}`,
          )
        }

        const userMarkers = agentInput.match(/### user \(clone-prediction\):/g) || []
        assert.equal(userMarkers.length, 19, 'exactly 19 user turns should remain in the window')
      },
    )
  })

  it('extracts all assistant texts from current iteration window', async () => {
    writeState(workdir, { iteration: 2 })
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    const historyPath = join(workdir, '.claude', 'clone-loop.history.local.jsonl')
    writeFileSync(
      historyPath,
      JSON.stringify({
        ts: '2026-01-01T00:00:10Z',
        event: 'stop',
        decision: 'continue',
        iteration: 2,
        confidence: 0.9,
        threshold: 0.8,
        prediction_id: 'p-cont',
        status: 'auto',
        predicted_response: 'Run focused tests next.',
      }) + '\n',
    )

    const transcriptPath = join(workdir, 'transcript.jsonl')
    const transcriptLines = [
      {
        timestamp: '2026-01-01T00:00:05Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'OLD assistant text before continue.' }] },
      },
      {
        timestamp: '2026-01-01T00:00:15Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'NEW assistant text alpha.' }] },
      },
      {
        timestamp: '2026-01-01T00:00:20Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Some user message ignored.' }] },
      },
      {
        timestamp: '2026-01-01T00:00:25Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'NEW assistant text beta.' }] },
      },
    ]
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n')

    await withMcpServer(
      {
        id: 'prediction-history-4',
        status: 'auto',
        threshold: 0.8,
        predicted_response: 'Continue.',
        confidence: 0.9,
        candidates: [],
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, {
          transcriptPath,
          lastAssistantMessage: '',
        })

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        const agentInput = calls[1].params.arguments.agent_input
        assert.match(agentInput, /### assistant \(current iter 3\):/)
        assert.match(agentInput, /NEW assistant text alpha\./)
        assert.match(agentInput, /NEW assistant text beta\./)
        assert.doesNotMatch(agentInput, /OLD assistant text before continue\./)
      },
    )
  })

  it('prefers CLONE_API_TOKEN over a saved plugin API key', async () => {
    writeState(workdir)
    const pluginDataDir = mkdtempSync(join(tmpdir(), 'clone-plugin-data-'))
    writeFileSync(
      join(pluginDataDir, 'auth.local.json'),
      `${JSON.stringify({ clone_api_token: 'clone_saved_hook_token_1234567890' }, null, 2)}\n`,
    )

    try {
      await withMcpServer(
        {
          id: 'prediction-5',
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
          const result = await runHook(workdir, endpoint, {
            token: 'clone_env_hook_token_1234567890',
            pluginDataDir,
          })

          assert.equal(
            result.status,
            0,
            JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2),
          )
          assert.equal(calls[0].headers['x-clone-api-key'], 'clone_env_hook_token_1234567890')
          assert.equal(calls[1].headers['x-clone-api-key'], 'clone_env_hook_token_1234567890')
        },
      )
    } finally {
      rmSync(pluginDataDir, { recursive: true, force: true })
    }
  })
})
