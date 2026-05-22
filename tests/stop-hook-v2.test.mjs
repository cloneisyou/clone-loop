import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withCloneMcpServer } from './helpers/clone-mcp-server.mjs'

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
  const { writeLoopStart = true, ...stateOverrides } = overrides
  const state = {
    iteration: 1,
    max_iterations: 3,
    session_id: 'session-123',
    clone_threshold: 0.6,
    clone_agent: 'Claude Code Clone Loop',
    clone_session_id: '',
    mcp_session_id: '',
    last_prompt_event_id: '',
    started_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    prompt: 'Fix the bug and run tests.',
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
    // Always set CLAUDE_PLUGIN_DATA to an isolated dir so the fallback path
    // doesn't accidentally read tokens stored in the developer's real config.
    env.CLAUDE_PLUGIN_DATA = options.pluginDataDir || join(workdir, '.clone-plugin-data')

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
  let responseCount = 0
  let promptCount = 0
  return withCloneMcpServer(
    {
      predict_next_prompt: () => prediction,
      record_agent_response: () => ({ event_id: `response-event-${++responseCount}` }),
      record_agent_prompt: () => ({ event_id: `prompt-event-${++promptCount}` }),
      submit_feedback: () => ({ ok: true }),
      stop_session: () => ({ ok: true }),
    },
    callback,
    { sessionId: 'mcp-session-123' },
  )
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
        threshold: 0.6,
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
        assert.match(calls[1].params.arguments.agent_input, /predict the most/)
        assert.match(calls[1].params.arguments.agent_input, /No single words, no "ok"/)

        assert.equal(calls[1].params.arguments.threshold, 0.6)
        assert.equal(calls[1].params.arguments.session_id, 'session-123')

        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'block')
        assert.match(output.reason, /Commit this and move on\./)
        assert.match(output.reason, /Confidence: 0\.91000/)
        assertProminentPredictedPrompt(output.reason, 2, 'Commit this and move on.')
        assert.doesNotMatch(output.reason, /mcp__clone__predict_next_prompt/)

        const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
        assert.match(state, /iteration: 2/)
      },
    )
  })

  it('blocks with a satisfaction message when Clone signals stop_recommended', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'prediction-satisfied',
        status: 'auto',
        threshold: 0.6,
        predicted_response: "good. that's the page.",
        confidence: 0.82,
        reasoning: "User's documented bar for this output is met.",
        stop_recommended: true,
        candidates: [],
        k: 1,
        model: 'test-model',
        latency_ms: 9,
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
        // Hook must emit a block() so the stop is visible to the user.
        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'block')
        // Header line uses purpleBold styling.
        assert.match(
          output.reason,
          new RegExp(
            escapeRegExp(
              `${ANSI_BOLD}${ANSI_PURPLE}Clone Loop: Clone predicted the task is complete. Additional user instruction is needed.${ANSI_RESET}`,
            ),
          ),
        )
        assertProminentPredictedPrompt(output.reason, 2, "good. that's the page.")
        // Loop state file removed so a new session doesn't resume.
        assert.throws(() => readFileSync(join(workdir, '.claude', 'clone-loop.local.md')))
        // History records the 'satisfied' decision kind.
        const history = readFileSync(join(workdir, '.claude', 'clone-loop.history.local.jsonl'), 'utf8')
        assert.match(history, /"decision":"satisfied"/)
      },
    )
  })

  it('ignores stop_recommended when confidence is below threshold', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'prediction-suspicious-satisfaction',
        status: 'escalated',
        threshold: 0.6,
        predicted_response: 'ship it',
        confidence: 0.42,
        reasoning: 'Weak match — could be hallucinated satisfaction.',
        stop_recommended: true,  // satisfaction claim, but...
        candidates: [],
        k: 1,
        model: 'test-model',
        latency_ms: 8,
      },
      async (endpoint) => {
        const result = await runHook(workdir, endpoint)

        assert.equal(result.status, 0)
        // ...confidence < threshold means we DON'T trust the stop signal.
        // Fall through to the normal low-confidence escalation path.
        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'block')
        assert.match(output.reason, /not confident enough/i)
      },
    )
  })

  it('removes loop state and escalates when Clone confidence is low', async () => {
    writeState(workdir)

    await withMcpServer(
      {
        id: 'prediction-2',
        status: 'escalated',
        threshold: 0.6,
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
        threshold: 0.6,
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

  it('injects multi-turn history with previously predicted prompts', async () => {
    writeState(workdir)
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    const historyPath = join(workdir, '.claude', 'clone-loop.history.local.jsonl')
    writeFileSync(
      historyPath,
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
        JSON.stringify({
          ts: '2026-01-01T00:00:05Z',
          event: 'stop',
          decision: 'continue',
          iteration: 2,
          confidence: 0.92,
          threshold: 0.6,
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
        threshold: 0.6,
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
      [
        JSON.stringify({
          ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          event: 'loop-start',
          session_id: 'session-123',
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:02Z',
          event: 'ask-user-question',
          decision: 'auto-answer-freeform',
          confidence: 0.91,
          threshold: 0.6,
          answers: { 'Should we open a PR?': 'Yes, open it as a draft.' },
        }),
      ].join('\n') + '\n',
    )

    await withMcpServer(
      {
        id: 'prediction-history-2',
        status: 'auto',
        threshold: 0.6,
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
    const lines = [
      JSON.stringify({
        ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        event: 'loop-start',
        session_id: 'session-123',
      }),
    ]
    for (let index = 1; index <= 30; index += 1) {
      lines.push(
        JSON.stringify({
          ts: `2026-01-01T00:${String(index).padStart(2, '0')}:00Z`,
          event: 'stop',
          decision: 'continue',
          iteration: index,
          confidence: 0.9,
          threshold: 0.6,
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
        threshold: 0.6,
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

        // The window caps the user-turn history at 20. With 30 user turns the
        // most recent 20 (predictions 11..30) remain; 1..10 should be dropped.
        // The current-iter assistant block is rendered separately and is not
        // subject to the cap.
        for (let index = 11; index <= 30; index += 1) {
          assert.match(
            agentInput,
            new RegExp(escapeRegExp(`Predicted prompt number ${index}.`)),
            `expected window to keep prediction ${index}`,
          )
        }
        for (let index = 1; index <= 10; index += 1) {
          assert.doesNotMatch(
            agentInput,
            new RegExp(escapeRegExp(`Predicted prompt number ${index}.`)),
            `expected window to drop prediction ${index}`,
          )
        }

        const userMarkers = agentInput.match(/### user \(clone-prediction\):/g) || []
        assert.equal(userMarkers.length, 20, 'exactly 20 user turns should remain in the window')
      },
    )
  })

  it('extracts all assistant texts from current iteration window', async () => {
    writeState(workdir, { iteration: 2 })
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    const historyPath = join(workdir, '.claude', 'clone-loop.history.local.jsonl')
    writeFileSync(
      historyPath,
      [
        JSON.stringify({
          ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          event: 'loop-start',
          session_id: 'session-123',
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:10Z',
          event: 'stop',
          decision: 'continue',
          iteration: 2,
          confidence: 0.9,
          threshold: 0.6,
          prediction_id: 'p-cont',
          status: 'auto',
          predicted_response: 'Run focused tests next.',
        }),
      ].join('\n') + '\n',
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
        threshold: 0.6,
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

  it('includes tool_use and tool_result blocks from the current iteration', async () => {
    writeState(workdir, { iteration: 2 })
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    const historyPath = join(workdir, '.claude', 'clone-loop.history.local.jsonl')
    writeFileSync(
      historyPath,
      [
        JSON.stringify({
          ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          event: 'loop-start',
          session_id: 'session-123',
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:10Z',
          event: 'stop',
          decision: 'continue',
          iteration: 2,
          confidence: 0.9,
          threshold: 0.6,
          prediction_id: 'p-rich',
          status: 'auto',
          predicted_response: 'Make the change.',
        }),
      ].join('\n') + '\n',
    )

    const transcriptPath = join(workdir, 'transcript.jsonl')
    const transcriptLines = [
      {
        timestamp: '2026-01-01T00:00:15Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'I will read the routes file first.' }] },
      },
      {
        timestamp: '2026-01-01T00:00:16Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/routes/todos.ts' } }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:17Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'line 1\nline 2\nline 3' }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:18Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'pnpm test' } }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:19Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'tests pass' }],
        },
      },
    ]
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n')

    await withMcpServer(
      {
        id: 'prediction-rich',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'Continue.',
        confidence: 0.9,
        candidates: [],
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, { transcriptPath, lastAssistantMessage: '' })

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        const agentInput = calls[1].params.arguments.agent_input
        assert.match(agentInput, /I will read the routes file first\./)
        assert.match(agentInput, /\[tool_use\] Read: file_path="src\/routes\/todos\.ts"/)
        assert.match(agentInput, /\[tool_use\] Bash: command="pnpm test"/)
        assert.match(agentInput, /\[tool_result Read\]:\nline 1\nline 2\nline 3/)
        assert.match(agentInput, /\[tool_result Bash\]:\ntests pass/)
      },
    )
  })

  it('summarizes long tool_result content with head and tail', async () => {
    writeState(workdir, { iteration: 2 })
    mkdirSync(join(workdir, '.claude'), { recursive: true })
    const historyPath = join(workdir, '.claude', 'clone-loop.history.local.jsonl')
    writeFileSync(
      historyPath,
      [
        JSON.stringify({
          ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          event: 'loop-start',
          session_id: 'session-123',
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:10Z',
          event: 'stop',
          decision: 'continue',
          iteration: 2,
          confidence: 0.9,
          threshold: 0.6,
          prediction_id: 'p-summary',
          status: 'auto',
          predicted_response: 'Carry on.',
        }),
      ].join('\n') + '\n',
    )

    const longLines = []
    for (let index = 1; index <= 50; index += 1) {
      longLines.push(`line ${index}`)
    }
    const transcriptPath = join(workdir, 'transcript.jsonl')
    const transcriptLines = [
      {
        timestamp: '2026-01-01T00:00:18Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: { command: 'cat big.log' } }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:19Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: longLines.join('\n') }],
        },
      },
    ]
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n')

    await withMcpServer(
      {
        id: 'prediction-summary',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'Continue.',
        confidence: 0.9,
        candidates: [],
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, { transcriptPath, lastAssistantMessage: '' })

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        const agentInput = calls[1].params.arguments.agent_input
        // Head: first 4 lines kept.
        assert.match(agentInput, /line 1\nline 2\nline 3\nline 4/)
        // Tail: last 2 lines kept.
        assert.match(agentInput, /line 49\nline 50/)
        // Marker shows how many were dropped.
        assert.match(agentInput, /\[44 more Bash lines\] \.\.\./)
        // Middle lines are not present verbatim.
        assert.doesNotMatch(agentInput, /\nline 25\n/)
      },
    )
  })

  it('removes stale loop state and does not continue when session IDs change', async () => {
    writeState(workdir, { session_id: 'session-aaa' })

    await withMcpServer(
      {
        id: 'prediction-session-update',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'Continue after session rotation.',
        confidence: 0.9,
        candidates: [],
      },
      async (endpoint, calls) => {
        // Hook receives a different session_id than what is stored in the state file.
        const result = await runHook(workdir, endpoint, { sessionId: 'session-bbb' })

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        assert.equal(result.stdout, '')
        assert.match(result.stderr, /stale-session-state/)
        assert.match(result.stderr, /Run \/clone:loop again/)
        assert.throws(() => readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8'))
        assert.equal(calls.length, 0)
      },
    )
  })

  it('removes stale loop state and does not continue when loop-start is missing', async () => {
    writeState(workdir, { writeLoopStart: false })

    await withMcpServer(
      {
        id: 'prediction-missing-loop-start',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'This must not be injected.',
        confidence: 0.99,
        candidates: [],
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint)

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        assert.equal(result.stdout, '')
        assert.match(result.stderr, /stale-missing-loop-start/)
        assert.throws(() => readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8'))
        assert.equal(calls.length, 0)
      },
    )
  })

  it('continues when started_at is old but recent loop activity exists', async () => {
    writeState(workdir, { started_at: '2000-01-01T00:00:00Z' })
    writeFileSync(
      join(workdir, '.claude', 'clone-loop.history.local.jsonl'),
      [
        JSON.stringify({
          ts: '2000-01-01T00:00:00Z',
          event: 'loop-start',
          session_id: 'session-123',
        }),
        JSON.stringify({
          ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          event: 'post-tool-use',
          session_id: 'session-123',
          iteration: 1,
          tool_name: 'Write',
        }),
      ].join('\n') + '\n',
    )

    await withMcpServer(
      {
        id: 'prediction-recent-activity',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'Continue despite old start time.',
        confidence: 0.99,
        candidates: [],
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint)

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'block')
        assert.match(output.reason, /Continue despite old start time\./)
        assert.ok(calls.length > 0)
      },
    )
  })

  it('removes stale loop state and does not continue after the activity TTL expires', async () => {
    writeState(workdir, { started_at: '2000-01-01T00:00:00Z' })

    await withMcpServer(
      {
        id: 'prediction-expired-state',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'This expired loop must not continue.',
        confidence: 0.99,
        candidates: [],
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint)

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))
        assert.equal(result.stdout, '')
        assert.match(result.stderr, /stale-expired-state/)
        assert.throws(() => readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8'))
        assert.equal(calls.length, 0)
      },
    )
  })

  it('records response and prompt in the active Clone MCP session', async () => {
    writeState(workdir, {
      clone_session_id: 'clone-session-stop',
      mcp_session_id: 'mcp-session-stop',
      last_prompt_event_id: 'prompt-event-prev',
    })

    await withMcpServer(
      {
        id: 'prediction-record-session',
        status: 'auto',
        threshold: 0.6,
        predicted_response: 'Run the focused regression tests.',
        confidence: 0.96,
        candidates: [],
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint)

        assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2))

        const responseCall = calls.find((call) => call.params?.name === 'record_agent_response')
        assert.ok(responseCall)
        assert.equal(responseCall.params.arguments.session_id, 'clone-session-stop')
        assert.equal(responseCall.params.arguments.in_response_to, 'prompt-event-prev')

        const predictCall = calls.find((call) => call.params?.name === 'predict_next_prompt')
        assert.ok(predictCall)
        assert.equal(predictCall.params.arguments.session_id, 'clone-session-stop')

        const promptCall = calls.find((call) => call.params?.name === 'record_agent_prompt')
        assert.ok(promptCall)
        assert.equal(promptCall.params.arguments.session_id, 'clone-session-stop')
        assert.equal(promptCall.params.arguments.prompt, 'Run the focused regression tests.')
        assert.equal(promptCall.params.arguments.source, 'clone-prediction')

        const state = readFileSync(join(workdir, '.claude', 'clone-loop.local.md'), 'utf8')
        assert.match(state, /last_prompt_event_id: "prompt-event-1"/)
      },
    )
  })
})
