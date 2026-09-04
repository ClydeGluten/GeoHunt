#!/usr/bin/env bash
set -Eeuo pipefail

declare -a service_pids=()
declare -a helper_pids=()

log() {
  printf '[geohunter] %s\n' "$*"
}

require_env() {
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      printf '[geohunter] Required environment variable %s is missing.\n' "$name" >&2
      exit 1
    fi
  done
}

wait_for() {
  local description="$1"
  shift
  local attempt
  for attempt in $(seq 1 90); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf '[geohunter] Timed out waiting for %s.\n' "$description" >&2
  return 1
}

shutdown() {
  trap - EXIT INT TERM
  log "Stopping services"
  local pid
  for pid in "${service_pids[@]}" "${helper_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap shutdown EXIT INT TERM

require_env POSTGRES_PASSWORD MIGRATOR_DB_PASSWORD APP_DB_PASSWORD MCP_DB_PASSWORD REDIS_PASSWORD BOT_TOKEN BOT_SERVICE_TOKEN

export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export POSTGRES_DB="${POSTGRES_DB:-geohunter}"
export POSTGRES_USER="${POSTGRES_USER:-postgres}"
export NODE_ENV="${NODE_ENV:-production}"
export BOT_MODE="${BOT_MODE:-polling}"
export TUNNEL_MODE="${TUNNEL_MODE:-quick}"
export APP_MODE="${APP_MODE:-all}"

mkdir -p "$PGDATA" /var/lib/redis /var/lib/caddy /var/log/geohunter /var/run/geohunter
chown -R redis:redis /var/lib/redis
chown -R caddy:caddy /var/lib/caddy

log "Starting PostgreSQL/PostGIS"
/usr/local/bin/docker-entrypoint.sh postgres &
service_pids+=("$!")

log "Starting Redis"
gosu redis redis-server \
  --dir /var/lib/redis \
  --appendonly yes \
  --requirepass "$REDIS_PASSWORD" \
  --maxmemory "${REDIS_MAXMEMORY:-256mb}" \
  --maxmemory-policy allkeys-lru &
service_pids+=("$!")

wait_for "PostgreSQL" pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
wait_for "Redis" redis-cli -h 127.0.0.1 -a "$REDIS_PASSWORD" ping

# A new PostgreSQL volume briefly uses a temporary server for initialization.
# Wait for the application roles before applying migrations.
for attempt in $(seq 1 90); do
  if PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc \
    "select 1 from pg_roles where rolname = 'geohunter_migrator'" 2>/dev/null | grep -qx 1; then
    break
  fi
  if [[ "$attempt" == "90" ]]; then
    printf '[geohunter] Database roles were not initialized.\n' >&2
    exit 1
  fi
  sleep 1
done
sleep 2
wait_for "final PostgreSQL postmaster" pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"

if [[ "$APP_MODE" == "database" ]]; then
  log "Database maintenance mode is ready"
  set +e
  wait -n "${service_pids[@]}"
  status=$?
  set -e
  exit "$status"
elif [[ "$APP_MODE" != "all" ]]; then
  printf '[geohunter] APP_MODE must be all or database.\n' >&2
  exit 1
fi

export DATABASE_URL="postgres://geohunter_migrator:${MIGRATOR_DB_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
log "Applying database migrations"
gosu geohunter node /opt/geohunter/migrate/dist/migrate.js

case "$TUNNEL_MODE" in
  quick|named) export SITE_ADDRESS=":80" ;;
  disabled) export SITE_ADDRESS="${SITE_ADDRESS:-:80}" ;;
  *)
    printf '[geohunter] TUNNEL_MODE must be quick, named, or disabled.\n' >&2
    exit 1
    ;;
esac

log "Starting web gateway"
gosu caddy caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
service_pids+=("$!")
wait_for "web gateway" curl --fail --silent http://127.0.0.1/

if [[ "$TUNNEL_MODE" == "quick" ]]; then
  tunnel_log=/var/log/geohunter/cloudflared.log
  : > "$tunnel_log"
  log "Requesting a Cloudflare quick tunnel"
  gosu geohunter cloudflared tunnel --no-autoupdate --url http://127.0.0.1:80 >"$tunnel_log" 2>&1 &
  service_pids+=("$!")
  tail -n +1 -F "$tunnel_log" &
  helper_pids+=("$!")

  public_url=""
  for attempt in $(seq 1 90); do
    public_url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$tunnel_log" | tail -n 1 || true)"
    [[ -n "$public_url" ]] && break
    sleep 1
  done
  if [[ -z "$public_url" ]]; then
    printf '[geohunter] Cloudflare did not issue a quick-tunnel URL.\n' >&2
    exit 1
  fi
  export PUBLIC_WEBAPP_URL="$public_url"
  export PUBLIC_BASE_URL="$public_url"
  export CORS_ORIGIN="$public_url,http://localhost,http://127.0.0.1"
elif [[ "$TUNNEL_MODE" == "named" ]]; then
  require_env CLOUDFLARED_TUNNEL_TOKEN PUBLIC_WEBAPP_URL
  export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-$PUBLIC_WEBAPP_URL}"
  export CORS_ORIGIN="${CORS_ORIGIN:-$PUBLIC_WEBAPP_URL}"
  log "Starting the named Cloudflare tunnel"
  gosu geohunter cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARED_TUNNEL_TOKEN" &
  service_pids+=("$!")
else
  export PUBLIC_WEBAPP_URL="${PUBLIC_WEBAPP_URL:-http://localhost}"
  export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-$PUBLIC_WEBAPP_URL}"
  export CORS_ORIGIN="${CORS_ORIGIN:-$PUBLIC_WEBAPP_URL}"
fi

printf '%s\n' "$PUBLIC_WEBAPP_URL" >/var/run/geohunter/public-url
log "Public URL: $PUBLIC_WEBAPP_URL"

export DATABASE_URL="postgres://geohunter_app:${APP_DB_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
export REDIS_URL="redis://:${REDIS_PASSWORD}@127.0.0.1:6379/0"
export API_INTERNAL_URL="http://127.0.0.1:3000/api"
export PORT=3000
export BOT_PORT=3001

log "Starting game API"
gosu geohunter node /opt/geohunter/api/dist/server.js &
service_pids+=("$!")
wait_for "game API" curl --fail --silent http://127.0.0.1:3000/api/ready

log "Starting Telegram bot"
gosu geohunter node /opt/geohunter/bot/dist/index.js &
service_pids+=("$!")
wait_for "Telegram bot" curl --fail --silent http://127.0.0.1:3001/health

log "All services are ready"
set +e
wait -n "${service_pids[@]}"
status=$?
set -e
printf '[geohunter] A required service stopped with status %s.\n' "$status" >&2
exit "$status"
