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
      'commands/status.md',
      'hooks/ask-user-question-hook.mjs',
      'hooks/hooks.json',
      'hooks/stop-hook.mjs',
      'LICENSE',
      'README.md',
      'scripts/setup-clone-loop.mjs',
    ]

    for (const file of pluginFiles) {
      assert.equal(existsSync(new URL(file, root)), true, `${file} exists`)
    }

    for (const file of [
      'hooks/stop-hook.sh',
      'scripts/run-plugin-bash.mjs',
      'scripts/setup-clone-loop.sh',
    ]) {
      assert.equal(existsSync(new URL(file, root)), false, `${file} is not published`)
    }
  })

  it('publishes only the supported public slash commands', () => {
    const commandFiles = readdirSync(new URL('commands/', root))
      .filter((file) => file.endsWith('.md'))
      .sort()

    assert.deepEqual(commandFiles, ['cancel-loop.md', 'help.md', 'loop.md', 'status.md'])
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

  it('exposes /clone:status as a read-only inspector for the loop state', () => {
    const statusCommand = read('commands/status.md')

    assert.match(statusCommand, /# Clone Loop Status/)
    assert.match(statusCommand, /\.claude\/clone-loop\.local\.md/)
    assert.match(statusCommand, /Read\(\.claude\/clone-loop\.local\.md\)/)
    assert.doesNotMatch(statusCommand, /\brm\b/)
    assert.doesNotMatch(statusCommand, /writeFileSync/)
  })

  it('runs Clone Loop setup directly through Node instead of Bash scripts', () => {
    const loopCommand = read('commands/loop.md')

    assert.match(loopCommand, /allowed-tools: Bash\(node \*setup-clone-loop\.mjs\*\)/)
    assert.match(
      loopCommand,
      /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/setup-clone-loop\.mjs" \$ARGUMENTS/,
    )
    assert.match(loopCommand, /Use the Bash tool/)
    assert.doesNotMatch(loopCommand, /```!/)
    assert.doesNotMatch(loopCommand, /run-plugin-bash/)
  })

  it('exposes a token-gated Clone MCP end-to-end test script', () => {
    const pkg = JSON.parse(read('package.json'))

    assert.equal(pkg.scripts['test:mcp:e2e'], 'node --test tests/remote-mcp-e2e.test.mjs')
    assert.equal(existsSync(new URL('tests/remote-mcp-e2e.test.mjs', root)), true)
  })

  it('runs the Stop hook directly through Node', () => {
    const hooks = JSON.parse(read('hooks/hooks.json'))
    const command = hooks.hooks.Stop[0].hooks[0].command

    assert.equal(
      command,
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.mjs"',
    )
  })

  it('runs a PreToolUse hook for AskUserQuestion directly through Node', () => {
    const hooks = JSON.parse(read('hooks/hooks.json'))
    const askUserQuestion = hooks.hooks.PreToolUse.find((entry) => entry.matcher === 'AskUserQuestion')

    assert.ok(askUserQuestion, 'AskUserQuestion PreToolUse hook is registered')
    assert.equal(
      askUserQuestion.hooks[0].command,
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/ask-user-question-hook.mjs"',
    )
  })

  it('persists Clone prediction settings when starting a Clone Loop', () => {
    const setup = read('scripts/setup-clone-loop.mjs')

    assert.match(setup, /let cloneThreshold = '0\.8'/)
    assert.match(setup, /let cloneK = '1'/)
    assert.match(setup, /let cloneAgent = 'Claude Code Clone Loop'/)
    assert.match(setup, /--clone-threshold/)
    assert.match(setup, /clone_threshold: \$\{cloneThreshold\}/)
    assert.match(setup, /clone_k: \$\{cloneK\}/)
    assert.match(setup, /clone_agent: \$\{quoteYaml\(cloneAgent\)\}/)
  })

  it('calls Clone MCP from the hook and passes confident predictions to Claude', () => {
    const hook = read('hooks/stop-hook.mjs')

    assert.match(hook, /clonePredictNextPrompt/)
    assert.match(hook, /tools\/call/)
    assert.match(hook, /predict_next_prompt/)
    assert.match(hook, /last_assistant_message/)
    assert.match(hook, /predicted_response/)
    assert.match(hook, /confidence/)
    assert.match(hook, /Number\(predictedConfidence\) >= Number\(cloneThreshold\)/)
    assert.match(hook, /user-configured confidence threshold/)
    assert.match(hook, /human escalation/)
    assert.doesNotMatch(hook, /mcp__clone__submit_feedback/)
    assert.doesNotMatch(hook, /Git Bash/)
  })

  it('formats confident predicted prompts as a prominent block', () => {
    const hook = read('hooks/stop-hook.mjs')

    assert.match(hook, /ANSI_PURPLE = '\\u001b\[35m'/)
    assert.match(hook, /purpleBold\("\*\*Clone predicted the user's next prompt\*\*"\)/)
    assert.match(hook, /Confidence: \$\{predictedConfidence\} \/ threshold: \$\{cloneThreshold\}/)
    assert.match(hook, /purple\(`> \$\{formatBlockquote\(predictedResponse\)\}`\)/)
  })
})
