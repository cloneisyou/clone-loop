$ErrorActionPreference = "Stop"

$GitHubRepo = "cloneisyou/clone-loop"
$MarketplaceName = "clone-loop"
$PluginRef = "clone-labs@clone-loop"

$ClaudeCommand = Get-Command claude.exe -ErrorAction SilentlyContinue
if (-not $ClaudeCommand) {
  $ClaudeCommand = Get-Command claude -ErrorAction SilentlyContinue
}

if (-not $ClaudeCommand) {
  Write-Error "Clone install failed: Claude Code CLI was not found on PATH. Install Claude Code, then rerun this installer."
  exit 1
}

$ClaudeBin = $ClaudeCommand.Source
Write-Host "Installing Clone with $ClaudeBin..."

& $ClaudeBin plugin marketplace add "$GitHubRepo@main"
if ($LASTEXITCODE -ne 0) {
  Write-Host "Marketplace add did not complete; refreshing $MarketplaceName if it already exists."
  & $ClaudeBin plugin marketplace update $MarketplaceName
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Clone install failed: could not add or update the $MarketplaceName marketplace."
    exit 1
  }
}

& $ClaudeBin plugin install $PluginRef --scope user
if ($LASTEXITCODE -ne 0) {
  Write-Host "Install did not complete; trying plugin update for an existing install."
  & $ClaudeBin plugin update $PluginRef
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Clone install failed: could not install or update $PluginRef."
    exit 1
  }
}

Write-Host ""
$GhCommand = Get-Command gh -ErrorAction SilentlyContinue
if ($GhCommand) {
  $PreviousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $GhCommand.Source repo star $GitHubRepo *> $null
    $StarExitCode = $LASTEXITCODE
  } catch {
    $StarExitCode = 1
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }

  if ($StarExitCode -eq 0) {
    Write-Host "Starred $GitHubRepo."
  } else {
    Write-Host "Could not star automatically. Check GitHub CLI authentication with: gh auth status"
  }
} else {
  Write-Host "Skipping GitHub star because GitHub CLI is not installed."
}

Write-Host ""
Write-Host "Clone is installed."
Write-Host ""
Write-Host "Open your agent and paste:"
Write-Host '/clone:loop "Run tests and fix any failures" --max-iterations 5'
Write-Host ""
Write-Host "Optional API key setup:"
Write-Host "/clone:api-key status"
