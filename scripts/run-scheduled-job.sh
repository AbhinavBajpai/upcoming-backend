#!/usr/bin/env bash
set -euo pipefail
umask 077
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
job="${1:-}"
case "$job" in
  sync) heartbeat_url="${SYNC_HEARTBEAT_URL:-}" ;;
  backup) heartbeat_url="${BACKUP_HEARTBEAT_URL:-}" ;;
  *) echo 'Choose sync or backup' >&2; exit 1 ;;
esac
# Limit configuration syntax before passing the private URL through curl's stdin.
if [[ -n "$heartbeat_url" && ! "$heartbeat_url" =~ ^https://uptime\.betterstack\.com/api/v1/heartbeat/[A-Za-z0-9]+$ ]]; then
  echo UPCOMING_HEARTBEAT_CONFIGURATION_INVALID >&2
  exit 1
fi
if [[ "$job" == sync ]]; then
  result_file="$(mktemp)"
  trap 'rm -f -- "$result_file"' EXIT
  "$repo_dir/scripts/production-compose.sh" run --rm --no-deps sync | tee "$result_file"
  # A concurrent sync holds the database lock: skipping is not a completed import.
  if ! grep -qF '"status":"succeeded"' "$result_file"; then
    echo UPCOMING_SYNC_HEARTBEAT_SKIPPED
    exit 0
  fi
else
  "$repo_dir/scripts/backup.sh"
fi
if [[ -z "$heartbeat_url" ]]; then
  echo UPCOMING_HEARTBEAT_NOT_CONFIGURED
  exit 0
fi
# No URL in process arguments/logs, no redirects, response body or job output sent.
if ! printf 'url = "%s"\n' "$heartbeat_url" |
  curl --disable --config - --silent --fail --output /dev/null \
    --connect-timeout 5 --max-time 15 --retry 2; then
  echo UPCOMING_HEARTBEAT_DELIVERY_FAILED >&2
  exit 1
fi
printf 'UPCOMING_%s_HEARTBEAT_OK\n' "${job^^}"
