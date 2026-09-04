param([Parameter(Mandatory = $true)][string]$BackupFile)
$ErrorActionPreference = "Stop"
$resolvedBackup = (Resolve-Path -LiteralPath $BackupFile).Path
if (-not [System.IO.File]::Exists($resolvedBackup)) { throw "Backup file not found: $resolvedBackup" }

$containerFile = "/tmp/geohunter-restore.dump"
$maintenanceContainer = "geohunter-restore"
Write-Warning "This replaces the selected deployment's database contents. Press Ctrl+C within 10 seconds to abort."
Start-Sleep -Seconds 10

try {
  docker compose stop app
  if ($LASTEXITCODE -ne 0) { throw "Could not stop GeoHunter" }

  docker compose run -d --no-deps --name $maintenanceContainer -e APP_MODE=database app | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not start database maintenance mode" }

  $ready = $false
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    docker exec $maintenanceContainer pg_isready -h 127.0.0.1 -U postgres -d geohunter | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "Database maintenance mode did not become ready" }

  docker cp $resolvedBackup "${maintenanceContainer}:$containerFile"
  if ($LASTEXITCODE -ne 0) { throw "Could not copy backup into maintenance container" }

  $databaseUser = (docker exec $maintenanceContainer printenv POSTGRES_USER).Trim()
  $databaseName = (docker exec $maintenanceContainer printenv POSTGRES_DB).Trim()
  docker exec $maintenanceContainer pg_restore -U $databaseUser -d $databaseName --clean --if-exists --no-owner $containerFile
  if ($LASTEXITCODE -ne 0) { throw "Database restore failed" }
}
finally {
  docker rm -f $maintenanceContainer 2>$null | Out-Null
  docker compose up -d app
}

Write-Host "Restore complete. Wait for the container to become healthy, then verify replay and table counts."
