# Film catalogue and TMDB sync

## Data model

`upcoming.films` has a stable UUID and a unique TMDB ID. A film's title/poster metadata can change without changing its identity. Future stars reference the film UUID, not a date or a release event.

`upcoming.releases` stores country, release type and a nullable PostgreSQL `date`. Identical `(film, country, type, date)` records, including unknown dates, are unique. Matching records retain their release UUID when refreshed. Multiple distinct release dates and revivals are retained. A calendar query selects GB/type-3 events in the requested month, sorts by those dates and can choose the earliest matching event per film for a single card. Do not use a film's primary release year to exclude revivals.

`upcoming.sync_runs` records the window, start/completion times, status, discovery/refreshed counts and a sanitized error code. A successful completion is the timestamp the future calendar API should expose. Failed runs do not advance it.

## Local command

Set `TMDB_READ_ACCESS_TOKEN` in the backend `.env`, then run:

```bash
npm run db:up
npm run db:migrate
npm run sync:films
```

The default window covers seven full calendar months, starting with the current month in Europe/London. For an explicit window:

```bash
npm run sync:films -- 2026-09 7
```

## Docker command

From `upcoming-backend`:

```bash
docker compose --profile tools run --build --rm -T sync
```

The one-shot service starts PostgreSQL if required, applies migrations and imports the films. It does not start the app service. The token is passed only to this server-side job at runtime; it is never copied into the image or sent to the browser. `docker compose config` can print interpolated environment secrets: use `docker compose config --quiet` for configuration validation.

For a custom window with the built image:

```bash
docker compose --profile tools run --rm -T sync sh -c 'node dist/migrate.js && node --use-env-proxy dist/sync.js 2026-09 7'
```

The current UI is still the foundation from UP-02. UP-05 and UP-06 will connect this catalogue to the monthly API and interface.

## Daily scheduling

The command is designed for a host scheduler; no queue server or always-running worker is needed. After building the image, a cron entry can run it daily (adjust the absolute path and log destination):

```cron
0 4 * * * cd /absolute/path/upcoming-backend && docker compose --profile tools run --rm -T sync >> /absolute/path/upcoming-sync.log 2>&1
```

This uses the host's timezone. No cron entry is installed automatically. Home-server scheduling and owner-visible failure alerts remain part of UP-13/UP-14. For manual inspection:

```bash
docker compose exec db psql -U upcoming -d upcoming -c 'SELECT started_at, completed_at, status, discovered_count, refreshed_count, error_code FROM upcoming.sync_runs ORDER BY started_at DESC LIMIT 10;'
```

## Failure and reconciliation rules

- Use monthly discovery to collect candidate IDs with complete pagination. Validate API response shapes and refuse a detected pagination/count change instead of accepting a partial result.
- Fetch explicit GB release records with movie metadata using `append_to_response=release_dates`. Ignore discovery's headline date when storing calendar events.
- Refresh **all previously imported films** as well as discovered IDs. At this scale this is a simple superset of known upcoming/starred films, including withdrawn and out-of-window dates. Revisit frequency if years of catalogue growth make this expensive.
- Fetch all snapshots before starting the database transaction. A failed request or malformed detail response leaves the previous catalogue unchanged. A transaction failure rolls back all film/event changes.
- A validated detail response can remove an obsolete GB event. A missing discovery result cannot delete a film or clear its dates. An empty GB group in a complete response means there are no currently known GB events; the film remains.
- At most five requests run concurrently, with paced starts, 20-second request timeouts and at most three attempts for network/429/5xx failures. Retry delays are bounded. HTTP auth/not-found errors fail without retry; a permanent upstream error must be investigated rather than silently erasing records. The conservative whole-run policy means one persistent bad response can hold back all updates until resolved.
- A PostgreSQL advisory lock covers the entire run. An overlapping process returns `skipped`. If a process is killed, its lock is released by PostgreSQL; the next lock owner marks the abandoned running record failed before proceeding.
- Log fixed error codes instead of raw exceptions, request headers or API response bodies. A database disconnect may prevent writing failure metadata; the next successful lock owner recovers the running record.

## Verification

`npm run check` runs unit tests, lint/type checks and build. Unit tests exercise dates, pagination, response validation, retries and concurrency without a token.

The integration suite requires an explicitly named **upcoming_test** database and clears only its fixture tables:

```bash
TEST_DATABASE_URL=postgres://upcoming:upcoming_test@localhost:55434/upcoming_test npm run test:integration
```

It applies migrations twice and verifies calendar/revival queries, stable identities, postponements, withdrawn/unknown dates, constraints, source failures, transaction rollback, overlapping runs and crash recovery. CI runs it against an isolated PostgreSQL service.

On 5 September 2026 the real importer successfully discovered and refreshed 145 films for September 2026–March 2027 in an isolated test database. This validates the import path; independent completeness against UK distributor calendars remains outside that result.
