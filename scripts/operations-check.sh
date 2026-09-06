#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
"$repo_dir/scripts/production-compose.sh" exec -T app node dist/operations.js
# Require a successful backup service run within the past 36 hours.
backup_result="$(systemctl show upcoming-backup.service --property=Result --value)"
backup_exit="$(systemctl show upcoming-backup.service --property=ExecMainStatus --value)"
backup_end="$(systemctl show upcoming-backup.service --property=ExecMainExitTimestamp --value)"
[[ "$backup_result" == success && "$backup_exit" == 0 && -n "$backup_end" ]] || { echo UPCOMING_BACKUP_HEALTH_FAILED >&2; exit 1; }
backup_age=$(( $(date +%s) - $(date -d "$backup_end" +%s) ))
(( backup_age >= 0 && backup_age < 129600 )) || { echo UPCOMING_BACKUP_STALE >&2; exit 1; }
printf 'UPCOMING_OPERATIONS_OK\n'
