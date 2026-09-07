#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT

test_repo="$temp_dir/repo"
fake_bin="$temp_dir/bin"
log_file="$temp_dir/docker.log"
mkdir -p "$test_repo/scripts" "$fake_bin"
cp "$repo_dir/scripts/judge-demo.sh" "$test_repo/scripts/judge-demo.sh"
printf 'WEB_PORT=18080\n' >"$test_repo/.env.judge"
printf 'services: {}\n' >"$test_repo/compose.yaml"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'printf "DEMO_MODE=%s ARGS=%s\\n" "${DEMO_MODE:-unset}" "$*" >>"$JUDGE_TEST_LOG"' \
  >"$fake_bin/docker"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'exit 0' \
  >"$fake_bin/curl"
chmod +x "$fake_bin/docker" "$fake_bin/curl" "$test_repo/scripts/judge-demo.sh"

output="$({
  env -u DEMO_MODE \
    PATH="$fake_bin:$PATH" \
    JUDGE_TEST_LOG="$log_file" \
    "$test_repo/scripts/judge-demo.sh"
} 2>&1)"
docker_log="$(<"$log_file")"

if [[ "$docker_log" != *"DEMO_MODE=true"* ]]; then
  printf 'Expected the no-argument launcher to enable DEMO_MODE.\n%s\n' "$docker_log" >&2
  exit 1
fi
if [[ "$docker_log" != *"up --build --detach --force-recreate"* ]]; then
  printf 'Expected the no-argument launcher to recreate a fresh demo process.\n%s\n' "$docker_log" >&2
  exit 1
fi
if [[ "$output" != *"Open the live deterministic match: http://localhost:18080/?demo=1"* ]]; then
  printf 'Expected the no-argument launcher to print the deterministic demo URL.\n%s\n' "$output" >&2
  exit 1
fi
if [[ "$output" == *"Use any 2-40 character trail name"* ]]; then
  printf 'The automated demo should not ask for a manual trail name.\n%s\n' "$output" >&2
  exit 1
fi

: >"$log_file"
manual_output="$({
  DEMO_MODE=true \
    PATH="$fake_bin:$PATH" \
    JUDGE_TEST_LOG="$log_file" \
    "$test_repo/scripts/judge-demo.sh" start
} 2>&1)"
manual_log="$(<"$log_file")"

if [[ "$manual_log" != *"DEMO_MODE=false"* ]]; then
  printf 'Expected explicit start mode to disable DEMO_MODE.\n%s\n' "$manual_log" >&2
  exit 1
fi
if [[ "$manual_output" != *"Use any 2-40 character trail name"* ]]; then
  printf 'Expected explicit start mode to explain the manual login flow.\n%s\n' "$manual_output" >&2
  exit 1
fi
if [[ "$manual_output" == *"?demo=1"* ]]; then
  printf 'Explicit start mode must not print the demo URL.\n%s\n' "$manual_output" >&2
  exit 1
fi

printf 'judge-demo mode-selection tests passed\n'
