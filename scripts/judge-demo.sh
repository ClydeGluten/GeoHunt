#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_dir/.env.judge"
docker_repo_dir="$repo_dir"
if command -v cygpath >/dev/null 2>&1; then
  docker_repo_dir="$(cygpath -m "$repo_dir")"
fi
compose=(
  docker compose
  --env-file "$docker_repo_dir/.env.judge"
  --project-directory "$docker_repo_dir"
  --file "$docker_repo_dir/compose.yaml"
)

write_env() {
  command -v openssl >/dev/null 2>&1 || {
    printf 'OpenSSL is required to generate disposable local secrets.\n' >&2
    exit 1
  }
  umask 077
  local admin migrator app mcp redis bot_service webhook web_port https_port postgres_port
  web_port="${GEOHUNT_JUDGE_WEB_PORT:-8080}"
  https_port="${GEOHUNT_JUDGE_HTTPS_PORT:-8443}"
  postgres_port="${GEOHUNT_JUDGE_POSTGRES_PORT:-55432}"
  for port in "$web_port" "$https_port" "$postgres_port"; do
    [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) || {
      printf 'Judge-demo ports must be integers from 1 through 65535.\n' >&2
      exit 2
    }
  done
  admin="$(openssl rand -hex 24)"
  migrator="$(openssl rand -hex 24)"
  app="$(openssl rand -hex 24)"
  mcp="$(openssl rand -hex 24)"
  redis="$(openssl rand -hex 24)"
  bot_service="$(openssl rand -hex 32)"
  webhook="$(openssl rand -hex 32)"
  printf '%s\n' \
    'COMPOSE_PROJECT_NAME=geohunter-judge' \
    'TUNNEL_MODE=disabled' \
    'SITE_ADDRESS=:80' \
    "WEB_PORT=$web_port" \
    "HTTPS_PORT=$https_port" \
    "POSTGRES_DEV_PORT=$postgres_port" \
    "PUBLIC_WEBAPP_URL=http://localhost:$web_port" \
    "PUBLIC_BASE_URL=http://localhost:$web_port" \
    "CORS_ORIGIN=http://localhost:$web_port,http://127.0.0.1:$web_port" \
    'MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty' \
    'BOT_MODE=disabled' \
    'BOT_TOKEN=0:browser-only-disabled-token' \
    "BOT_WEBHOOK_SECRET=$webhook" \
    "BOT_SERVICE_TOKEN=$bot_service" \
    'POSTGRES_DB=geohunter' \
    'POSTGRES_ADMIN_USER=postgres' \
    "POSTGRES_ADMIN_PASSWORD=$admin" \
    "MIGRATOR_DB_PASSWORD=$migrator" \
    "APP_DB_PASSWORD=$app" \
    "MCP_DB_PASSWORD=$mcp" \
    "REDIS_PASSWORD=$redis" \
    'NODE_ENV=production' \
    'DEV_AUTH_ENABLED=false' \
    'COOKIE_SECURE=false' \
    'SESSION_DAYS=1' \
    'LOG_LEVEL=info' >"$env_file"
}

start() {
  command -v docker >/dev/null 2>&1 || {
    printf 'Docker with the Compose plugin is required.\n' >&2
    exit 1
  }
  [[ -f "$env_file" ]] || write_env
  local web_port=8080 key value
  while IFS='=' read -r key value; do
    [[ "$key" == "WEB_PORT" ]] && web_port="$value"
  done <"$env_file"
  "${compose[@]}" config -q
  "${compose[@]}" up --build --detach
  for _ in $(seq 1 90); do
    if curl --fail --silent "http://127.0.0.1:$web_port/api/ready" >/dev/null; then
      printf '\nGeoHunt judge demo is ready: http://localhost:%s\n' "$web_port"
      printf 'Use any 2-40 character trail name; Telegram is not required.\n'
      return
    fi
    sleep 2
  done
  "${compose[@]}" ps
  "${compose[@]}" logs --tail=100 app
  printf 'The demo did not become ready within three minutes.\n' >&2
  exit 1
}

case "${1:-start}" in
  start) start ;;
  demo)
    export DEMO_MODE=true
    start
    web_port=8080
    while IFS='=' read -r key value; do
      [[ "$key" == "WEB_PORT" ]] && web_port="$value"
    done <"$env_file"
    printf 'Open the live deterministic match: http://localhost:%s/?demo=1\n' "$web_port"
    ;;
  stop) "${compose[@]}" down ;;
  reset)
    "${compose[@]}" down --volumes --remove-orphans
    rm -f -- "$env_file"
    ;;
  logs) "${compose[@]}" logs --follow app ;;
  status) "${compose[@]}" ps ;;
  *)
    printf 'Usage: %s [start|demo|stop|reset|logs|status]\n' "$0" >&2
    exit 2
    ;;
esac
