#!/usr/bin/env sh
set -eu

pg_isready -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-geohunter}" >/dev/null
redis-cli -h 127.0.0.1 -a "$REDIS_PASSWORD" ping 2>/dev/null | grep -qx PONG
curl --fail --silent --show-error http://127.0.0.1:3000/api/ready >/dev/null
curl --fail --silent --show-error http://127.0.0.1:3001/health >/dev/null
curl --fail --silent --show-error http://127.0.0.1/ >/dev/null
