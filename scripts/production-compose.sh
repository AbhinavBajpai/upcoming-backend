#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
case "${UPCOMING_INGRESS:-host}" in
  host|tunnel) ingress="${UPCOMING_INGRESS:-host}" ;;
  *) echo "UPCOMING_INGRESS must be host or tunnel" >&2; exit 1 ;;
esac
exec docker compose --project-directory "$repo_dir"   --env-file "${UPCOMING_ENV_FILE:-$repo_dir/.env.production}"   -f "$repo_dir/compose.production.yaml"   -f "$repo_dir/compose.production.$ingress.yaml" "$@"
