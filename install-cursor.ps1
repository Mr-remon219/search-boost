[CmdletBinding()]
param(
  [string]$Target = "",
  [switch]$Uninstall,
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) { Write-Error "node not found (>= 22.13)"; exit 1 }

$args = @("cli.mjs", "install")
if ($Uninstall) { $args = @("cli.mjs", "uninstall") }
if ($Target) { $args += @("-t", $Target) }
if ($DryRun) { $args += "--dry-run" }
if ($Yes) { $args += "-y" }

Push-Location $Root
try {
  if (-not (Test-Path "node_modules")) { npm install --silent | Out-Null }
  & $Node.Source @args
} finally { Pop-Location }
