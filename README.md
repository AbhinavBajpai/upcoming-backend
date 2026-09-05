# Upcoming backend

TypeScript + Express API for a UK theatrical-release calendar, with PostgreSQL and versioned migrations. React lives in the sibling `upcoming-frontend` repository. The foundation includes an application shell, health endpoints, local database setup, and the validated TMDB research command. Film storage and TMDB importing are now implemented. The public monthly calendar API is implemented; verified email/password accounts are implemented; stars and friendships are the next backlog slices.

## Run the local app with Docker

Keep `upcoming-backend` and `upcoming-frontend` as sibling directories. Docker with Compose 2.17+ is required; Node/npm do not need to be installed on the host for this mode.

From `upcoming-backend`, run:

```bash
docker compose up --build -d --wait
```

Open **http://localhost:3000**. Compose builds both repositories and starts the app and database containers, plus a local Mailpit inbox: Express serving the React build, and PostgreSQL. The app waits for a healthy database and runs pending migrations before listening. Database data is kept in a named volume. The app container runs as the unprivileged `node` user.

```bash
docker compose logs -f app  # application and migration logs
docker compose stop        # stop; retain containers and data
docker compose down        # remove containers/network; retain database data
```

After code changes, rerun `docker compose up --build -d --wait`. To change the browser port, set `APP_PORT=3005` in the backend `.env`, then open http://localhost:3005. Port 55432 exposes PostgreSQL on loopback for optional local development tools; change `POSTGRES_PORT` if needed. Inside Compose, the app always connects to `db:5432`, independently of the host `DATABASE_URL` setting.

Run these commands in your normal host terminal. No sandbox port publishing or Vite server is needed. The build copies source files explicitly and excludes `.env`; it does not bake the TMDB token into either image or the browser bundle. The web app does not need the token; the optional sync job receives it separately at runtime.

This configuration is for local testing, with local-only database credentials. It has no Cloudflare dependency. Home-server deployment and secret provisioning remain UP-13.

## Development with live reload

Use Node.js 22.22.1 (`nvm use`) and Docker with Compose. Clone the repositories side by side:

```text
upcoming/
  upcoming-backend/
  upcoming-frontend/
```

Install dependencies once in each repo:

```bash
npm ci
npm --prefix ../upcoming-frontend ci
```

If `.env` does not already exist, copy `.env.example` to `.env`. Do not overwrite an existing token. Local database and API settings have defaults; the TMDB token is only needed for the live validation command, not for app startup or tests.

Start PostgreSQL, apply migrations, and run both development servers with one command from this repo:

```bash
npm run dev:all
```

- Frontend: `http://localhost:5173`
- API liveness: `http://localhost:3000/api/health`
- Database readiness: `http://localhost:3000/api/ready`
- PostgreSQL: `localhost:55432`, database/user `upcoming`, local-only password `upcoming_local`.

Vite proxies `/api` to Express, so frontend requests should use relative URLs. No CORS setup or frontend credential is needed. The TMDB token must never be placed in the frontend repository or a `VITE_` variable.

If the containerised app is running, first use `docker compose stop app` to free port 3000.

`Ctrl+C` stops both development servers. The database remains running, with data in a named Docker volume. `npm run db:stop` stops it without deleting data. `docker compose down` removes the containers/network and retains the volume; do not use `down -v` unless you intend to delete local data.

If port 55432 is occupied, set `POSTGRES_PORT` and update the port in `DATABASE_URL`. If port 3000 changes, also set `API_PROXY_TARGET` in the frontend `.env`. Vite uses port 5173 and fails clearly if it is occupied.

Inside a sandbox, the browser on the host may require explicit port publishing. For this development sandbox, run on the host:

```bash
sbx ports codex-upcoming --publish 5173:5173/tcp
```

The frontend dev server listens on all container interfaces; its proxy reaches the API inside the same sandbox. Direct API publishing is optional.

## Database migrations

```bash
npm run db:up
npm run db:migrate
```

`node-pg-migrate` applies pending migrations transactionally and records them in `public.pgmigrations`. Migrations create the `upcoming` schema and its films, releases and sync-run tables. Running the command again is safe. Migration files live in `migrations/`; add a new migration instead of editing one that has already been applied. Do not run destructive rollback commands against user data.

## Production-build smoke test

```bash
npm --prefix ../upcoming-frontend run build
npm run build
npm start
```

Open `http://localhost:3000`: Express serves the frontend build and the API from the same hostname. `/releases`, `/starred` and `/friends` support direct navigation; missing assets and unknown `/api` routes remain 404s. `FRONTEND_DIST_DIR` changes the frontend artifact path. Build the frontend before starting Express.

For an actual deployment, set `NODE_ENV=production` and an explicit `DATABASE_URL`. Home-server containers, secret provisioning and the existing Cloudflare Tunnel route belong to UP-13; the Compose file here is for local development only.

## Checks

```bash
npm run check
```

This runs TypeScript, ESLint, unit tests (API/configuration, TMDB requests and date regressions), and the production build. Tests do not need a token or database. CI also runs the catalogue integration tests and applies migrations twice against a temporary PostgreSQL service. `npm run format` formats source and configuration files.

`/api/health` tests process liveness; `/api/ready` tests database connectivity and returns 503 on failure without exposing connection details. This readiness endpoint does not yet verify the application schema version.

## Import films

The catalogue stores films, regional release events and sync history. To import with Docker:

```bash
docker compose --profile tools run --build --rm -T sync
```

This one-shot job uses `TMDB_READ_ACCESS_TOKEN` from the backend `.env`. It refreshes the current UK month plus six months ahead, and rechecks known films for changed/withdrawn dates. The React calendar reads this catalogue through `GET /api/releases`. A fresh database shows an unrefreshed state until the first successful import. See [the calendar API contract](docs/calendar-api.md). See [the sync guide](docs/catalog-sync.md) for local Node commands, scheduling, failure behaviour and integration tests.

## TMDB validation

Requires Node.js with `--env-file` and `--use-env-proxy` support (verified with 22.22.1). No npm dependencies or database are needed for this check.

Create `.env` from `.env.example` if it does not already exist, and set `TMDB_READ_ACCESS_TOKEN` to the TMDB API Read Access Token. Keep it server-side. `.env` is ignored by Git; never put the token into frontend variables.

From this repository:

```bash
node --use-env-proxy --env-file=.env scripts/validate-tmdb.mjs
```

The default checks seven complete months starting in the current UK month. An explicit window makes the query reproducible (upstream data can still change):

```bash
node --use-env-proxy --env-file=.env scripts/validate-tmdb.mjs 2026-09 7
```

The command reads TMDB only, fetches all discovery pages and explicit release dates with at most five concurrent requests, and writes `docs/tmdb-validation.json` only after all requests succeed. It does not write to a database. Credentials, headers and raw upstream errors are omitted from output. The Markdown findings document is a reviewed snapshot and is not automatically rewritten by later runs.

Offline regression checks:

```bash
node --test
```

See [the findings and proposed date-selection rules](docs/tmdb-validation.md). The important observed case is a revival that qualifies for a future month while discovery returns the film's old release date.

## Accounts and local email

Rebuild with `docker compose up --build -d --wait`. The app remains at http://localhost:3000; open **http://localhost:8025** for the local Mailpit inbox. Create an account using any test email, open its captured verification message, follow the link, then sign in. Forgot-password messages appear in the same inbox. No emails leave the local stack. If the inbox does not load immediately, wait a moment for its container to start.

Verification links last one hour; reset links last 30 minutes and are single-use. Resets revoke existing sessions. Sessions last a fixed seven days. The Account page supports display-name changes, password changes, sign-out and revoking other devices. `/api/me` returns only `{user: {id, displayName}}` for a verified session, or 401. Other account endpoints live under `/api/auth`; cookies are required for protected actions, and POST requests require the configured browser Origin and JSON.

A per-address/type 60-second email cooldown and a 90-message daily budget apply, including locally. If you resend immediately, allow a minute before retrying. Failed provider deliveries log only a safe message; users can request a new link. Local inbox messages contain working account links, so Mailpit stays bound to loopback and is never routed through the public tunnel.

`APP_PORT` sets both the Docker web port and its auth origin. Use **localhost**, not a LAN address or `127.0.0.1`, for this default setup. `MAILPIT_PORT` changes the inbox port; `SMTP_PORT` changes the host SMTP port for Node development. `npm run dev:all` starts the database and Mailpit with the frontend at http://localhost:5173; its auth origin defaults to that URL.

Production authentication is a separate configuration: `AUTH_MODE=public`, an HTTPS `AUTH_BASE_URL`, a random `AUTH_SECRET` of at least 32 characters, `RESEND_API_KEY` and a verified `AUTH_EMAIL_FROM`. Generate a secret using your password manager or `openssl rand -base64 32`, then place it in the backend runtime environment. Never use the local fallback secret publicly. The local Compose file intentionally uses local mode and captured email; it is not the deployment configuration. Exact trusted proxy socket IPs can be set via `AUTH_TRUSTED_PROXY_IPS`; only those peers may supply Cloudflare's client IP header. Configure origin access restrictions with the tunnel before enabling that trust.

[The account decision and security model](docs/authentication.md) covers the selected library, costs and implementation boundaries. Real email sending and the home-server tunnel configuration remain untested until the owner provides deployment details. Library logs are disabled; do not add request logging that exposes cookies, passwords or verification/reset URLs.
