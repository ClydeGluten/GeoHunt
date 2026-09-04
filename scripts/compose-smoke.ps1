param(
  [string]$BaseUrl = "http://localhost"
)

$ErrorActionPreference = "Stop"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$matchId = $null

function Wait-ForApi {
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "$BaseUrl/api/health"
      $ready = Invoke-RestMethod -Uri "$BaseUrl/api/ready"
      if ($health.ok -and $ready.ok) { return }
    }
    catch {
      if ($attempt -eq 30) { throw }
    }
    Start-Sleep -Seconds 2
  }
  throw "Health checks failed"
}

try {
  Wait-ForApi

  $authBody = @{ displayName = "Compose Smoke Host" } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/auth/dev" -ContentType "application/json" -Body $authBody -WebSession $session | Out-Null

  $body = @'
{
  "name": "Disposable Compose Smoke Match",
  "playzone": {
    "type": "Polygon",
    "coordinates": [[[66.9000, 48.0000], [66.9020, 48.0000], [66.9020, 48.0020], [66.9000, 48.0000]]]
  },
  "settings": {
    "durationSeconds": 600,
    "hideSeconds": 30,
    "tapTagEnabled": true,
    "autoTagEnabled": false,
    "tagRadiusMeters": 15,
    "autoTagDwellSeconds": 5,
    "tagCooldownSeconds": 5,
    "positionMaxAgeSeconds": 15,
    "maxAccuracyMeters": 50,
    "maxSpeedMps": 15,
    "caughtBehavior": "SPECTATOR",
    "boundaryGraceSeconds": 30,
    "boundaryAudience": "HOST",
    "boundaryDisqualify": false
  },
  "visibilityRules": []
}
'@

  $created = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/matches" -ContentType "application/json" -Body $body -WebSession $session
  $matchId = $created.matchId
  if (-not $matchId) { throw "Match creation did not return an id" }

  $snapshot = Invoke-RestMethod -Uri "$BaseUrl/api/v1/matches/$matchId" -WebSession $session
  if ($snapshot.state -ne "DRAFT" -or $snapshot.viewerRole -ne "HOST") { throw "Created match snapshot was invalid" }

  $invite = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/matches/$matchId/invite" -ContentType "application/json" -Body "{}" -WebSession $session
  if (-not $invite.inviteCode) { throw "Invite creation failed" }

  Write-Output "Compose smoke passed for match $matchId"
}
finally {
  if ($matchId) {
    Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/v1/matches/$matchId" -WebSession $session | Out-Null
  }
}
