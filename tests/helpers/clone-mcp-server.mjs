import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export async function withCloneMcpServer(handlers, callback, options = {}) {
  const calls = []
  const sessionId = options.sessionId || 'mcp-session-test'
  const server = createServer(async (req, res) => {
    let body = ''
    req.setEncoding('utf8')
    for await (const chunk of req) body += chunk
    const payload = JSON.parse(body)
    calls.push({ method: payload.method, params: payload.params, headers: req.headers })

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream')
    if (payload.method === 'initialize') {
      res.setHeader('mcp-session-id', sessionId)
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { capabilities: {} } })}\n\n`)
      return
    }

    assert.equal(payload.method, 'tools/call')
    const toolName = payload.params?.name
    const handler = handlers[toolName] || handlers.default
    if (!handler) throw new Error(`Unexpected tool call: ${toolName}`)
    const result = await handler({ payload, calls, req })
    if (result?.mcp_session_id) res.setHeader('mcp-session-id', result.mcp_session_id)
    res.end(
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result || { ok: true }) }] },
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
