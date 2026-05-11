import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const root = new URL('../', import.meta.url)

function read(path) {
  return readFileSync(new URL(path, root), 'utf8')
}

describe('Clone Claude plugin contract', () => {
  it('publishes the plugin under the clone slug', () => {
    const manifest = JSON.parse(read('.claude-plugin/plugin.json'))

    assert.equal(manifest.name, 'clone')
    assert.match(manifest.description, /Clone/i)
    assert.match(manifest.description, /Clone Loop/i)
  })

  it('includes Clone Loop plugin files and command entries', () => {
    const pluginFiles = [
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'commands/cancel-loop.md',
      'commands/help.md',
      'commands/loop.md',
      'hooks/hooks.json',
      'hooks/stop-hook.sh',
      'LICENSE',
      'README.md',
      'scripts/run-plugin-bash.mjs',
      'scripts/setup-clone-loop.sh',
    ]

    for (const file of pluginFiles) {
      assert.equal(existsSync(new URL(file, root)), true, `${file} exists`)
    }
  })

  it('publishes only the supported public slash commands', () => {
    const commandFiles = readdirSync(new URL('commands/', root))
      .filter((file) => file.endsWith('.md'))
      .sort()

    assert.deepEqual(commandFiles, ['cancel-loop.md', 'help.md', 'loop.md'])
  })

  it('registers the remote Clone MCP server for Claude Code', () => {
    const mcp = JSON.parse(read('.mcp.json'))

    assert.equal(mcp.mcpServers.clone.url, 'https://api.clone.is/mcp')
    assert.equal(
      mcp.mcpServers.clone.headers['X-Clone-API-Key'],
      '${CLONE_API_TOKEN:-clone_yc-reviewer-public-demo-2026}',
    )
  })

  it('documents /clone:loop as the primary command', () => {
    const readme = read('README.md')
    const loopCommand = read('commands/loop.md')

    assert.match(readme, /\/clone:loop/)
    assert.match(loopCommand, /# Clone Loop Command/)
  })

  it('runs Clone Loop setup through the Node bash launcher instead of shell pre-execution', () => {
    const loopCommand = read('commands/loop.md')

    assert.match(loopCommand, /allowed-tools: Bash\(node \*run-plugin-bash\.mjs\*\)/)
    assert.match(
      loopCommand,
      /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/run-plugin-bash\.mjs" scripts\/setup-clone-loop\.sh \$ARGUMENTS/,
    )
    assert.match(loopCommand, /Use the Bash tool/)
    assert.doesNotMatch(loopCommand, /```!/)
  })

  it('runs the Stop hook through the Node bash launcher', () => {
    const hooks = JSON.parse(read('hooks/hooks.json'))
    const command = hooks.hooks.Stop[0].hooks[0].command

    assert.equal(
      command,
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/run-plugin-bash.mjs" hooks/stop-hook.sh',
    )
  })

  it('persists Clone prediction settings when starting a Clone Loop', () => {
    const setup = read('scripts/setup-clone-loop.sh')

    assert.match(setup, /CLONE_THRESHOLD="0\.8"/)
    assert.match(setup, /CLONE_K="1"/)
    assert.match(setup, /CLONE_AGENT="Claude Code Clone Loop"/)
    assert.match(setup, /--clone-threshold/)
    assert.match(setup, /clone_threshold: \$CLONE_THRESHOLD/)
    assert.match(setup, /clone_k: \$CLONE_K/)
    assert.match(setup, /clone_agent: "\$CLONE_AGENT"/)
  })

  it('calls Clone MCP from the hook and passes confident predictions to Claude', () => {
    const hook = read('hooks/stop-hook.sh')

    assert.match(hook, /clone_predict_next_prompt/)
    assert.match(hook, /tools\/call/)
    assert.match(hook, /predict_next_prompt/)
    assert.match(hook, /last_assistant_message/)
    assert.match(hook, /predicted_response/)
    assert.match(hook, /confidence/)
    assert.match(hook, /confidence_clears_threshold/)
    assert.match(hook, /user-configured confidence threshold/)
    assert.match(hook, /human escalation/)
    assert.doesNotMatch(hook, /mcp__clone__submit_feedback/)
  })
})
