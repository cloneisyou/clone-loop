import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const endpoint = process.env.CLONE_MCP_URL ?? 'https://api.clone.is/mcp'
const demoToken = 'clone_yc-reviewer-public-demo-2026'

function cloneApiToken() {
  return process.env.CLONE_API_TOKEN?.trim() || demoToken
}

function parseSse(text) {
  const dataFrames = text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n')
        .trim(),
    )
    .filter(Boolean)

  for (const data of dataFrames) {
    try {
      return JSON.parse(data)
    } catch {}
  }

  return text ? JSON.parse(text) : null
}

async function rpc(method, params = {}, mcpSessionId = null) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Clone-API-Key': cloneApiToken(),
  }
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  })

  const text = await res.text()
  return {
    status: res.status,
    text,
    mcpSessionId: res.headers.get('mcp-session-id') ?? mcpSessionId,
    payload: text ? parseSse(text) : null,
  }
}

async function initialize() {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'clone-plugin-e2e-test', version: '0.0.0' },
  })

  assert.equal(init.status, 200, init.text)
  assert.equal(init.payload?.result?.serverInfo?.name, 'clone')
  assert.ok(init.mcpSessionId, 'initialize returned an mcp-session-id header')
  return init.mcpSessionId
}

async function toolCall(name, args, mcpSessionId) {
  return rpc(
    'tools/call',
    {
      name,
      arguments: args,
    },
    mcpSessionId,
  )
}

function parseToolBody(result, toolName) {
  assert.equal(result.status, 200, result.text)
  assert.ifError(result.payload?.error)

  const content = result.payload?.result?.content?.[0]
  assert.equal(content?.type, 'text', `${toolName} returned text content`)
  assert.ok(content.text, `${toolName} returned non-empty text`)

  try {
    return JSON.parse(content.text)
  } catch {
    return { text: content.text }
  }
}

function assertThresholdSemantics(body, threshold) {
  assert.ok(['auto', 'escalated'].includes(body.status), `unexpected status: ${body.status}`)
  assert.equal(typeof body.confidence, 'number')
  assert.equal(body.threshold, threshold)
  if (body.status === 'auto') {
    assert.ok(body.confidence >= threshold, `auto confidence ${body.confidence} is below ${threshold}`)
  } else {
    assert.ok(body.confidence < threshold, `escalated confidence ${body.confidence} is not below ${threshold}`)
  }
}

function eventId(body, toolName) {
  const id = body.event_id ?? body.id
  assert.equal(typeof id, 'string', `${toolName} returned an event id`)
  assert.ok(id.length > 0, `${toolName} event id is non-empty`)
  return id
}

function sessionId(body) {
  const id = body.session_id ?? body.sessionId
  assert.equal(typeof id, 'string', 'start_session returned a session id')
  assert.ok(id.length > 0, 'start_session session id is non-empty')
  return id
}

describe('Remote Clone MCP end-to-end flow', () => {
  it('records a synthetic session, predicts next prompt, predicts continuation, submits feedback, and stops the session', { timeout: 60000 }, async () => {
    const mcpSessionId = await initialize()

    const tools = await rpc('tools/list', {}, mcpSessionId)
    assert.equal(tools.status, 200, tools.text)
    const toolNames = tools.payload.result.tools.map((tool) => tool.name)
    assert.ok(
      ['predict_next_prompt', 'predict_continuation', 'start_session', 'stop_session', 'record_agent_prompt', 'record_agent_response', 'submit_feedback'].every((tool) =>
        toolNames.includes(tool),
      ),
      'MCP server exposes every tool needed for the E2E flow',
    )

    const sourceDetail = `clone-plugin-e2e-${Date.now()}`
    let cloneSessionId = null

    try {
      const started = parseToolBody(
        await toolCall(
          'start_session',
          {
            source: 'integration',
            source_detail: sourceDetail,
          },
          mcpSessionId,
        ),
        'start_session',
      )
      cloneSessionId = sessionId(started)

      const prompt = parseToolBody(
        await toolCall(
          'record_agent_prompt',
          {
            session_id: cloneSessionId,
            agent: 'Claude Code Clone MCP E2E Test',
            prompt: 'Synthetic test prompt: should the agent run the focused verifier before stopping?',
            source: 'integration',
            source_detail: sourceDetail,
          },
          mcpSessionId,
        ),
        'record_agent_prompt',
      )
      const promptEventId = eventId(prompt, 'record_agent_prompt')

      const response = parseToolBody(
        await toolCall(
          'record_agent_response',
          {
            session_id: cloneSessionId,
            agent: 'Claude Code Clone MCP E2E Test',
            response: 'Synthetic test response: the verifier passed and the agent is about to stop.',
            in_response_to: promptEventId,
            source: 'integration',
            source_detail: sourceDetail,
          },
          mcpSessionId,
        ),
        'record_agent_response',
      )
      eventId(response, 'record_agent_response')

      const threshold = 0.8
      const prediction = parseToolBody(
        await toolCall(
          'predict_next_prompt',
          {
            agent: 'Claude Code Clone MCP E2E Test',
            agent_input: [
              'Original synthetic task: validate the Clone MCP E2E flow.',
              `Session id: ${cloneSessionId}`,
              'Latest agent output: verifier passed and the agent is about to stop.',
              'Question: what would the user likely ask next?',
            ].join('\n'),
            k: 3,
            threshold,
            session_id: cloneSessionId,
          },
          mcpSessionId,
        ),
        'predict_next_prompt',
      )

      assert.equal(typeof prediction.id, 'string')
      assert.ok(prediction.predicted_response)
      assert.equal(typeof prediction.predicted_response, 'string')
      assert.ok(Array.isArray(prediction.candidates), 'predict_next_prompt returned candidates')
      assert.ok(prediction.candidates.length <= 3, 'predict_next_prompt returned at most k candidates')
      assertThresholdSemantics(prediction, threshold)

      const continuation = parseToolBody(
        await toolCall(
          'predict_continuation',
          {
            agent: 'Claude Code Clone MCP E2E Test',
            agent_input: 'Synthetic latest iteration output: tests passed, no files remain dirty, and the completion criteria are met.',
            threshold,
            session_id: cloneSessionId,
          },
          mcpSessionId,
        ),
        'predict_continuation',
      )

      assert.equal(typeof continuation.should_continue, 'boolean')
      assertThresholdSemantics(continuation, threshold)

      parseToolBody(
        await toolCall(
          'submit_feedback',
          {
            prediction_id: prediction.id,
            status: 'accepted',
          },
          mcpSessionId,
        ),
        'submit_feedback',
      )
    } finally {
      if (cloneSessionId) {
        parseToolBody(
          await toolCall(
            'stop_session',
            {
              session_id: cloneSessionId,
              source: 'integration',
              source_detail: sourceDetail,
            },
            mcpSessionId,
          ),
          'stop_session',
        )
      }
    }
  })

  it('returns a JSON-RPC error for invalid tool arguments', { timeout: 60000 }, async () => {
    const mcpSessionId = await initialize()
    const invalid = await toolCall(
      'submit_feedback',
      {
        status: 'accepted',
      },
      mcpSessionId,
    )

    assert.ok(invalid.status === 200 || invalid.status >= 400, invalid.text)
    assert.ok(
      invalid.payload?.error || invalid.payload?.result?.isError,
      'invalid submit_feedback arguments returned an MCP error',
    )
  })
})
