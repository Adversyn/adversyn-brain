# Adversyn — PowerShell convenience wrapper for the Nova intake.
# Examples:
#   .\scripts\nova-create-issue.ps1 examples\nova-task-codex.json
#   .\scripts\nova-create-issue.ps1 examples\nova-task-codex.json -DryRun

param(
  [Parameter(Mandatory = $true)]
  [string]$TaskFile,

  [switch]$DryRun,

  [switch]$NoGh
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $TaskFile)) {
  Write-Error "Task file not found: $TaskFile"
  exit 1
}

$nodeArgs = @('scripts/create-github-issue-from-nova.mjs', $TaskFile)
if ($DryRun) { $nodeArgs += '--dry-run' }
if ($NoGh)   { $nodeArgs += '--no-gh' }

& node @nodeArgs
exit $LASTEXITCODE
