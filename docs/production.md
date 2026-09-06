# Ubuntu deployment and operations (UP-13 / UP-14)

Prepared for the existing Ubuntu home server. Live installation is pending inspection of the host architecture, ports, cloudflared topology, SSH access and credentials. Do not treat local smoke results as a successful public deployment.

## Release configuration

Keep both repos side by side, for example `/opt/upcoming/upcoming-backend` and `/opt/upcoming/upcoming-frontend`. Use tested commits in both repos. Docker builds the React frontend and backend into one image; PostgreSQL is a separate persistent container. Require Docker Engine with Compose v2 supporting named build contexts. On Ubuntu also install Restic, rclone (for Dropbox), and use the existing systemd scheduler.

Copy `.env.production.example` to `.env.production` and make it mode 600. Fill in private values. Use a random **hex** database password (it is embedded in a connection URL), an independent auth secret, the existing TMDB token and Resend sending key. Set `RELEASE_TAG` to a unique release identifier, preferably containing the backend and frontend short commit IDs. Never rebuild a different release under the same tag. Keep a copy of the private settings and backup password in a password manager outside this server.

This production file replaces the auth-only `.env.public` template from UP-21. The app's HTTPS origin and sender are fixed to the agreed names in production Compose. The wrapper explicitly loads `.env.production`, never the local `.env`.

Inspect Ubuntu before deployment:

```bash
uname -m
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Networks}}'
docker network ls
ss -ltn
```

Choose `UPCOMING_INGRESS=host` for a host-service or host-networked cloudflared; select an unused APP_PORT (template: 3080) and route to `http://127.0.0.1:3080`. Choose `UPCOMING_INGRESS=tunnel` for bridge-networked cloudflared; set TUNNEL_NETWORK to its existing network and route to `http://upcoming-web:3000`. Confirm that alias is unused. Export the same UPCOMING_INGRESS for interactive operations and put it in the systemd operations environment. See [email and DNS setup](hosted-setup.md) for Cloudflare steps and exact proxy-trust configuration.

The database has no published port and uses an internal network. Only the app joins the optional external tunnel network. App/sync have outbound network access for Resend/TMDB. Docker supports attaching services to private and external networks independently. [Compose networking](https://docs.docker.com/reference/compose-file/networks/).

For the first deployment:

```bash
export UPCOMING_INGRESS=host # or tunnel, after inspection
scripts/production-compose.sh config --quiet
scripts/production-compose.sh build app
scripts/production-compose.sh up -d --wait db app
scripts/production-compose.sh run --rm --no-deps sync
node scripts/beta-smoke.mjs https://upcoming.crashpalace.uk
```

The app's existing entrypoint runs reviewed migrations before starting; a migration failure stops startup. The sync service uses the same tagged image and runs only after the app has migrated successfully. No Mailpit is deployed. Restart policies recover containers after reboot; enable Docker on boot. Docker health checks mark unhealthy apps but do not automatically restart a still-running unhealthy process—inspect readiness failures and restart after addressing the cause.

Before each subsequent release, take a successful off-server backup, record its snapshot ID and both current Git commits/image tag. Pause the sync timer while changing versions. Build the new unique tag, recreate the app, check readiness/public routes and re-enable the timer. Use the documented production commands, not the local Compose commands. Do not run `down -v`, prune the live volume, or delete previous release images during a deployment.

For rollback, restore the previous RELEASE_TAG and recreate the app with `up --no-build -d --wait app`. This works only when the previous code supports the migrated schema. Migrations are not automatically reversed. If incompatible, stop app and sync, preserve the failed database volume, restore the pre-release backup into a **new** volume, and start the matching previous image against it after verifying data. This deliberate recovery needs reviewed configuration for that incident; the restore-check script never overwrites production. Any writes since that snapshot will be lost.

## Encrypted backups, including Dropbox

The backup script uses PostgreSQL's custom-format compressed dump, including film, account, session, watch-list and friendship tables. It finishes the dump in a private temporary directory before uploading, so a pg_dump failure cannot create a misleading successful snapshot. Restic encrypts it before off-server storage. A trap removes the temporary plaintext dump on normal exit/failure; a power failure can leave a private temporary directory that needs cleanup.

Dropbox is supported through rclone. Run `rclone config` as the account that will run backups and authorize a Dropbox remote named `dropbox` in your browser. Protect its config file (it contains an OAuth token). Use:

```text
RESTIC_REPOSITORY=rclone:dropbox:Upcoming/backups
RESTIC_PASSWORD_FILE=/etc/upcoming/restic-password
RCLONE_CONFIG=/etc/upcoming/rclone.conf
```

Keep the Restic password in your password manager too: Dropbox access alone cannot decrypt a backup. A Dropbox-synced local directory is not treated as a completed off-server upload by these scripts. Direct upload gives the backup job a result from remote storage. [Restic rclone repositories](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html), [Dropbox authorization](https://rclone.org/dropbox/).

After supplying those environment variables privately, initialize the dedicated repository once with `restic init`, then run `scripts/backup.sh`. Do not initialize a second repository over an existing one. The retention policy keeps 7 daily, 4 weekly and 3 monthly snapshots, scoped to the Upcoming tag/host. `forget --prune` removes old snapshot references and reclaims their unused data after each successful upload. Run `restic check` periodically to verify repository structure. Schedule deeper `restic check --read-data` checks periodically as quota allows. Never run another sync tool against this repository concurrently.

Restore verification:

```bash
restic snapshots --tag upcoming-db
scripts/restore-check.sh SNAPSHOT_ID
```

The script downloads the selected dump, restores it into a temporary PostgreSQL 17 container with no network or published ports, verifies table readability and prints counts for films/releases/users/accounts/stars/friendships. pg_restore validates constraints while loading. It then removes the container and temporary data. Compare counts with the expected snapshot and exercise representative data in a separate staging app for the live beta acceptance pass. No tokens or personal rows are printed.

Nightly backups give a target worst-case data-loss window of roughly 24 hours while jobs succeed. Restoring after server loss requires Docker, both repositories/the matching image, database backup, Restic password, provider credentials, AUTH_SECRET, TMDB/Resend keys and the Cloudflare tunnel setup. Keep credentials separately backed up. Successful database backup alone does not preserve server configuration. Recovery time must be measured in the live drill.

## Scheduling and checks

The systemd templates assume a dedicated `upcoming` account with Docker access and repos at `/opt/upcoming`; adapt these paths/user after server inspection. Membership of the Docker group grants host administration capability. Install `/etc/upcoming/operations.env` from the example and protect it; systemd loads it as environment variables, not shell code. The Restic password and rclone config must be readable only by the intended service account. Install the unit files from `deploy/systemd`, run `systemctl daemon-reload`, then enable:

```bash
sudo systemctl enable --now upcoming-sync.timer upcoming-backup.timer upcoming-check.timer
systemctl list-timers 'upcoming-*'
```

Sync runs daily at 03:15 UTC, backup at 04:15 UTC, each with up to five minutes of jitter. Persistent timers catch up after downtime. The hourly check fails if the latest sync is failed/stale (36 hours) or the backup service has not successfully completed within 36 hours. A sync still running at check time is treated as not healthy; recheck after completion. systemd does not overlap instances of the same service. Inspect failures with:

```bash
systemctl --failed
journalctl -u upcoming-sync -u upcoming-backup -u upcoming-check --since yesterday
```

The journal and failed-unit status provide local visibility. The owner selected Better Stack for external uptime monitoring and job heartbeats; follow the setup below and verify receipt of an alert before closing UP-14. An on-server check cannot report its own power/network failure.

Incremental cost: email should remain £0 within Resend's free allowance. Dropbox can use existing available storage; verify actual quota before enabling retention. Power/internet are existing costs. Measure the real dump and repository size after first backup; posters are remote images and are not in the database.

## Better Stack alerts

Use an external HTTPS monitor on `https://upcoming.crashpalace.uk/api/ready`, expected status 200, with email alerts. Create separate sync and backup heartbeats expecting a ping every 24 hours with one hour of grace. Save their private URLs as `SYNC_HEARTBEAT_URL` and `BACKUP_HEARTBEAT_URL` in `/etc/upcoming/operations.env`; never commit them.

Reinstall the updated sync/backup service units (adapting User to the deployment account) and run `systemctl daemon-reload`. The scheduled-job wrapper pings only after an actual successful import or a completed backup including retention. A skipped concurrent sync does not ping. Jobs that fail send no success heartbeat; Better Stack alerts after the interval plus grace. Heartbeat delivery failure produces a generic journal error and fails the service without rerunning the job. Existing direct/manual sync and backup commands do not send heartbeats.

Start each service once and confirm its heartbeat becomes Up. Better Stack starts monitoring after the first ping. Use its test-alert control, if available, or a separate short-interval test heartbeat to verify that a deliberately missed ping reaches the owner's inbox; do not pause production backups for an alert test. [Better Stack heartbeat behavior](https://betterstack.com/docs/uptime/cron-and-heartbeat-monitor/).
