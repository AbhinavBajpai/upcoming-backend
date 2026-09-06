#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${RESTIC_REPOSITORY:?Set an off-server Restic repository}"
: "${RESTIC_PASSWORD_FILE:?Set a private Restic password file}"
case "$RESTIC_REPOSITORY" in
  sftp:*|s3:*|b2:*|azure:*|gs:*|rclone:*|rest:https://*) ;;
  *) echo "Backups require a remote repository; local paths are not accepted" >&2; exit 1 ;;
esac
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
backup_dir="$(mktemp -d)"
trap 'rm -rf -- "$backup_dir"' EXIT
# Finish the dump before uploading: a failed pg_dump must never produce a snapshot.
"$repo_dir/scripts/production-compose.sh" exec -T db pg_dump -U upcoming -d upcoming   --format=custom --no-owner --no-acl > "$backup_dir/upcoming.dump"
restic backup --tag upcoming-db --host upcoming-production --stdin   --stdin-filename upcoming.dump < "$backup_dir/upcoming.dump"
# Retention is scoped to this application's snapshots. Review before enabling.
restic forget --tag upcoming-db --host upcoming-production --group-by host,paths   --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune
printf 'UPCOMING_BACKUP_OK\n'
