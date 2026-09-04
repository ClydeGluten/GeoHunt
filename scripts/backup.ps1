param([string]$OutputDirectory = "backups")
$ErrorActionPreference = "Stop"
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory))
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$fileName = "geohunter-$stamp.dump"
$containerFile = "/tmp/$fileName"
docker compose exec -T app sh -c "pg_dump -U \"`$POSTGRES_USER\" -d \"`$POSTGRES_DB\" --format=custom --file=$containerFile"
docker compose cp "app:$containerFile" (Join-Path $resolvedOutput $fileName)
docker compose exec -T app rm -f $containerFile
Write-Host "Backup created: $(Join-Path $resolvedOutput $fileName)"
