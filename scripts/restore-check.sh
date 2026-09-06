#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${RESTIC_REPOSITORY:?Set the backup repository}"
: "${RESTIC_PASSWORD_FILE:?Set the Restic password file}"
snapshot="${1:?Pass an explicit snapshot ID from restic snapshots --tag upcoming-db}"
[[ "$snapshot" =~ ^[a-f0-9]{8,64}$ ]] || { echo 'Use an explicit snapshot ID' >&2; exit 1; }
restore_dir="$(mktemp -d)"
restore_name="upcoming-restore-$(date +%s)-$$"
cleanup() {
  docker rm -fv "$restore_name" >/dev/null 2>&1 || true
  rm -rf -- "$restore_dir"
}
trap cleanup EXIT
restic dump "$snapshot" upcoming.dump > "$restore_dir/upcoming.dump"
# No published ports and no network; this cannot reach the live app or database.
docker run -d --name "$restore_name" --network none   -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=upcoming_restore   postgres:17-alpine >/dev/null
ready=false
for attempt in {1..60}; do
  # The entrypoint's temporary initialization server accepts Unix sockets before
  # POSTGRES_DB exists. TCP becomes available only on the final server; SELECT
  # also proves the target database is usable (pg_isready does not prove that).
  if docker exec "$restore_name" psql -h 127.0.0.1 -U postgres \
    -d upcoming_restore -v ON_ERROR_STOP=1 -Atqc 'SELECT 1' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
$ready || { echo 'Restore database failed to start' >&2; exit 1; }
docker exec -i "$restore_name" pg_restore -h 127.0.0.1 -U postgres -d upcoming_restore   --exit-on-error --no-owner --no-acl < "$restore_dir/upcoming.dump"
docker exec "$restore_name" psql -h 127.0.0.1 -U postgres -d upcoming_restore -v ON_ERROR_STOP=1 -c   'SET search_path TO upcoming, public; SELECT (SELECT count(*) FROM upcoming.films) AS films, (SELECT count(*) FROM upcoming.releases) AS releases, (SELECT count(*) FROM auth_user) AS users, (SELECT count(*) FROM auth_account) AS accounts, (SELECT count(*) FROM upcoming.stars) AS stars, (SELECT count(*) FROM upcoming.friendships) AS friendships;'
printf 'UPCOMING_RESTORE_CHECK_OK (inspect counts against expected data)\n'
