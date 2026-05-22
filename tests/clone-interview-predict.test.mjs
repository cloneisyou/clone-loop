import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scriptPath = join(pluginRoot, 'scripts', 'predict-interview-answer.mjs')

function writeInterviewState(workdir, overrides = {}) {
  const state = {
    topic: 'Add billing',
    mode: 'deep',
    maxQuestions: 12,
    sessionId: 'session-123',
    threshold: 0.75,
    agent: 'Claude Code Clone Interview',
    autoAnswer: true,
    outputPath: '.claude/clone-interview.local.md',
    body: `# Clone Interview

## Topic

Add billing

## Working Ledger

### Code Facts

- [from-code][auto-confirmed] Node ESM package.

## Goal Contract

- **Why:** TBD
- **Desired outcome:** TBD

## Decision Ledger

| Source | Decision | Plan impact |
|---|---|---|
| [from-code][auto-confirmed] | Node ESM package | Tests should use node:test. |

## Plan Draft

### Implementation Phases

- TBD

## Readiness Audit

- [ ] One-sentence goal is unambiguous.
`,
    ...overrides,
  }
  mkdirSync(join(workdir, '.claude'), { recursive: true })
  writeFileSync(
    join(workdir, '.claude', 'clone-interview.local.md'),
    `---
active: true
topic: "${state.topic}"
mode: "${state.mode}"
max_questions: ${state.maxQuestions}
question_count: 0
session_id: "${state.sessionId}"
clone_threshold: ${state.threshold}
clone_agent: "${state.agent}"
auto_answer: ${state.autoAnswer ? 'true' : 'false'}
started_at: "2026-01-01T00:00:00Z"
output_path: "${state.outputPath}"
---

${state.body}
`,
  )
}

function runPredict(workdir, endpoint, input, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: workdir,
      env: {
        ...process.env,
        CLONE_MCP_URL: endpoint,
        CLONE_API_TOKEN: options.token || 'test-token',
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

    child.stdin.end(JSON.stringify({ cwd: workdir, session_id: 'session-123', ...input }))
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
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { serverInfo: { name: 'clone' }, capabilities: {} } })}\n\n`)
      return
    }

    assert.equal(payload.method, 'tools/call')
    if (payload.params.name === 'submit_feedback') {
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } })}\n\n`)
      return
    }

    assert.equal(payload.params.name, 'predict_next_prompt')
    const prediction = queue.shift()
    res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: JSON.stringify(prediction) }] } })}\n\n`)
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
    res.end('synthetic failure')
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  try {
    return await callback(`http://127.0.0.1:${port}/mcp`, calls)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

describe('Clone Interview prediction script', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'clone-interview-predict-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('returns auto and records accepted feedback when confidence clears threshold', async () => {
    writeInterviewState(workdir)

    await withMcpServer(
      {
        id: 'interview-prediction-1',
        status: 'auto',
        predicted_response: 'Ship CSV only in v1 and leave XLSX out of scope.',
        confidence: 0.91,
      },
      async (endpoint, calls) => {
        const result = await runPredict(workdir, endpoint, {
          question: 'Should import support CSV only or CSV and XLSX?',
          answer_kind: 'freeform',
        })

        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'auto')
        assert.equal(output.answer, 'Ship CSV only in v1 and leave XLSX out of scope.')
        assert.equal(output.confidence, 0.91)
        assert.deepEqual(calls.map((call) => call.params?.name || call.method), ['initialize', 'predict_next_prompt', 'submit_feedback'])
        assert.match(calls[1].params.arguments.agent_input, /Current Clone Interview spec/)
        assert.match(calls[1].params.arguments.agent_input, /Goal Contract/)
        assert.match(calls[1].params.arguments.agent_input, /Decision Ledger/)
        assert.match(calls[1].params.arguments.agent_input, /Plan Draft/)
        assert.match(calls[1].params.arguments.agent_input, /Should import support CSV only/)

        const history = readFileSync(join(workdir, '.claude', 'clone-interview.history.local.jsonl'), 'utf8')
        assert.match(history, /"event":"interview-auto-answer"/)
        assert.match(history, /"event":"feedback-sent"/)
      },
    )
  })

  it('escalates when confidence is below threshold and keeps interview state', async () => {
    writeInterviewState(workdir)

    await withMcpServer(
      {
        id: 'interview-prediction-2',
        status: 'escalated',
        predicted_response: 'Use usage-based pricing.',
        confidence: 0.42,
      },
      async (endpoint) => {
        const result = await runPredict(workdir, endpoint, {
          question: 'What pricing model should billing use?',
          answer_kind: 'freeform',
        })

        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'escalate')
        assert.equal(output.suggestion, 'Use usage-based pricing.')
        assert.ok(readFileSync(join(workdir, '.claude', 'clone-interview.local.md'), 'utf8'))
        const history = readFileSync(join(workdir, '.claude', 'clone-interview.history.local.jsonl'), 'utf8')
        assert.match(history, /"reason":"low-confidence"/)
      },
    )
  })

  it('maps high-confidence choice predictions to option labels', async () => {
    writeInterviewState(workdir)

    await withMcpServer(
      {
        id: 'interview-prediction-3',
        status: 'auto',
        predicted_response: 'Option B. CSV and XLSX',
        confidence: 0.88,
      },
      async (endpoint) => {
        const result = await runPredict(workdir, endpoint, {
          question: 'Which import format scope?',
          answer_kind: 'choice',
          options: [{ label: 'CSV only' }, { label: 'CSV and XLSX' }],
        })

        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'auto')
        assert.equal(output.answer, 'CSV and XLSX')
      },
    )
  })

  it('escalates on Clone MCP error without deleting interview state', async () => {
    writeInterviewState(workdir)

    await withFailingMcpServer(async (endpoint) => {
      const result = await runPredict(workdir, endpoint, {
        question: 'What is the launch scope?',
        answer_kind: 'freeform',
      })

      assert.equal(result.status, 0, result.stderr)
      const output = JSON.parse(result.stdout)
      assert.equal(output.decision, 'escalate')
      assert.match(output.error, /HTTP 500/)
      assert.ok(readFileSync(join(workdir, '.claude', 'clone-interview.local.md'), 'utf8'))
    })
  })

  it('escalates without calling MCP when auto-answer is disabled', async () => {
    writeInterviewState(workdir, { autoAnswer: false })

    await withMcpServer(
      {
        id: 'unused',
        predicted_response: 'Do not use',
        confidence: 0.99,
      },
      async (endpoint, calls) => {
        const result = await runPredict(workdir, endpoint, {
          question: 'What should we do?',
          answer_kind: 'freeform',
        })

        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        assert.equal(output.decision, 'escalate')
        assert.equal(output.reason, 'Auto-answer disabled.')
        assert.deepEqual(calls, [])
      },
    )
  })
})
