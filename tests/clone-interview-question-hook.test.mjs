import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hookPath = join(pluginRoot, 'hooks', 'interview-question-hook.mjs')

function writeInterviewState(workdir, overrides = {}) {
  const state = {
    sessionId: 'session-123',
    threshold: 0.75,
    autoAnswer: true,
    ...overrides,
  }
  mkdirSync(join(workdir, '.claude'), { recursive: true })
  writeFileSync(
    join(workdir, '.claude', 'clone-interview.local.md'),
    `---
active: true
topic: "Add billing"
mode: "deep"
max_questions: 12
question_count: 0
session_id: "${state.sessionId}"
clone_threshold: ${state.threshold}
clone_agent: "Claude Code Clone Interview"
auto_answer: ${state.autoAnswer ? 'true' : 'false'}
started_at: "2026-01-01T00:00:00Z"
output_path: ".claude/clone-interview.local.md"
---

# Clone Interview

## Topic

Add billing
`,
  )
}

function writeLoopState(workdir) {
  mkdirSync(join(workdir, '.claude'), { recursive: true })
  writeFileSync(join(workdir, '.claude', 'clone-loop.local.md'), '---\nactive: true\n---\nloop\n')
}

function runHook(workdir, endpoint, toolInput, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd: workdir,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
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

    child.stdin.end(JSON.stringify({
      session_id: options.sessionId || 'session-123',
      tool_name: 'AskUserQuestion',
      tool_input: toolInput,
    }))
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
    calls.push({ method: payload.method, params: payload.params })

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream')
    if (payload.method === 'initialize') {
      res.setHeader('mcp-session-id', 'mcp-session-123')
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { serverInfo: { name: 'clone' }, capabilities: {} } })}\n\n`)
      return
    }
    if (payload.params.name === 'submit_feedback') {
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } })}\n\n`)
      return
    }
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

describe('Clone Interview AskUserQuestion hook', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'clone-interview-hook-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('fills AskUserQuestion answers when Clone prediction clears threshold', async () => {
    writeInterviewState(workdir)

    await withMcpServer(
      {
        id: 'interview-hook-1',
        status: 'auto',
        predicted_response: 'CSV only',
        confidence: 0.92,
      },
      async (endpoint) => {
        const result = await runHook(workdir, endpoint, {
          questions: [
            {
              question: 'Which import scope?',
              options: [{ label: 'CSV only' }, { label: 'CSV and XLSX' }],
            },
          ],
        })

        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        assert.equal(output.hookSpecificOutput.permissionDecision, 'allow')
        assert.equal(output.hookSpecificOutput.updatedInput.answers['Which import scope?'], 'CSV only')
        assert.match(output.hookSpecificOutput.permissionDecisionReason, /Clone Interview answered/)
      },
    )
  })

  it('does not override AskUserQuestion when prediction confidence is low', async () => {
    writeInterviewState(workdir)

    await withMcpServer(
      {
        id: 'interview-hook-2',
        status: 'escalated',
        predicted_response: 'Usage-based billing.',
        confidence: 0.32,
      },
      async (endpoint) => {
        const result = await runHook(workdir, endpoint, {
          questions: [{ question: 'What pricing model should billing use?', options: [{ label: 'Usage' }, { label: 'Seat' }] }],
        })

        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, '')
        const history = readFileSync(join(workdir, '.claude', 'clone-interview.history.local.jsonl'), 'utf8')
        assert.match(history, /"reason":"low-confidence"/)
      },
    )
  })

  it('stays silent when Clone Loop state exists so the loop hook owns the question', async () => {
    writeInterviewState(workdir)
    writeLoopState(workdir)

    await withMcpServer(
      {
        id: 'unused',
        predicted_response: 'CSV only',
        confidence: 0.99,
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, {
          questions: [{ question: 'Which import scope?', options: [{ label: 'CSV only' }] }],
        })

        assert.equal(result.status, 0)
        assert.equal(result.stdout, '')
        assert.deepEqual(calls, [])
      },
    )
  })

  it('stays silent when no Clone Interview is active', async () => {
    await withMcpServer(
      {
        id: 'unused',
        predicted_response: 'CSV only',
        confidence: 0.99,
      },
      async (endpoint, calls) => {
        const result = await runHook(workdir, endpoint, {
          questions: [{ question: 'Which import scope?', options: [{ label: 'CSV only' }] }],
        })

        assert.equal(result.status, 0)
        assert.equal(result.stdout, '')
        assert.deepEqual(calls, [])
      },
    )
  })
})
