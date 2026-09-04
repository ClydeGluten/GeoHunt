param(
  [string]$EnvironmentFile = ".env.example",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot

try {
  if (-not $SkipBuild) {
    & docker compose --env-file $EnvironmentFile build app
    if ($LASTEXITCODE -ne 0) { throw "Application image build failed" }
  }

  & docker compose --env-file $EnvironmentFile up -d
  if ($LASTEXITCODE -ne 0) { throw "Compose startup failed" }

  & "$PSScriptRoot/compose-smoke.ps1"
  if ($LASTEXITCODE -ne 0) { throw "Authenticated Compose smoke failed" }
}
finally {
  & docker compose --env-file $EnvironmentFile down
  Pop-Location
}
