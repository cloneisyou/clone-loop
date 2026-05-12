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

  return JSON.parse(text)
}

async function rpc(method, params = {}, sessionId = null) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Clone-API-Key': cloneApiToken(),
  }
  if (sessionId) headers['mcp-session-id'] = sessionId

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
    sessionId: res.headers.get('mcp-session-id'),
    payload: text ? parseSse(text) : null,
  }
}

describe('Remote Clone MCP connection', () => {
  it('lists tools and calls predict_next_prompt through Streamable HTTP', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clone-plugin-test', version: '0.0.0' },
    })
    assert.equal(init.status, 200, init.text)
    assert.equal(init.payload.result.serverInfo.name, 'clone')
    assert.ok(init.sessionId)

    const tools = await rpc('tools/list', {}, init.sessionId)
    assert.equal(tools.status, 200, tools.text)
    const toolNames = tools.payload.result.tools.map((tool) => tool.name)
    assert.ok(toolNames.includes('predict_next_prompt'))

    const prediction = await rpc(
      'tools/call',
      {
        name: 'predict_next_prompt',
        arguments: {
          agent: 'Claude Code Clone Loop',
          agent_input: 'Test finished. What next?',
          k: 3,
          threshold: 0.7,
        },
      },
      init.sessionId,
    )
    assert.equal(prediction.status, 200, prediction.text)
    const content = prediction.payload.result.content[0]
    assert.equal(content.type, 'text')
    const body = JSON.parse(content.text)
    assert.ok(['auto', 'escalated'].includes(body.status))
    assert.ok(body.predicted_response)
    assert.equal(typeof body.confidence, 'number')
    assert.equal(body.threshold, 0.7)
    if (body.status === 'auto') {
      assert.ok(body.confidence >= 0.7)
    } else {
      assert.ok(body.confidence < 0.7)
    }
  })
})
