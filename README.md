# Upcoming backend

TypeScript + Express API for a UK theatrical-release calendar, with PostgreSQL and versioned migrations. React lives in the sibling `upcoming-frontend` repository. The foundation includes an application shell, health endpoints, local database setup, and the validated TMDB research command. Film storage/import, accounts, stars, and friendships are the next backlog slices.

## Run the local app with Docker

Keep `upcoming-backend` and `upcoming-frontend` as sibling directories. Docker with Compose 2.17+ is required; Node/npm do not need to be installed on the host for this mode.

From `upcoming-backend`, run:

```bash
docker compose up --build -d --wait
```

Open **http://localhost:3000**. Compose builds both repositories and starts two containers: Express serving the React build, and PostgreSQL. The app waits for a healthy database and runs pending migrations before listening. Database data is kept in a named volume. The app container runs as the unprivileged `node` user.

```bash
docker compose logs -f app  # application and migration logs
docker compose stop        # stop; retain containers and data
docker compose down        # remove containers/network; retain database data
```

After code changes, rerun `docker compose up --build -d --wait`. To change the browser port, set `APP_PORT=3005` in the backend `.env`, then open http://localhost:3005. Port 55432 exposes PostgreSQL on loopback for optional local development tools; change `POSTGRES_PORT` if needed. Inside Compose, the app always connects to `db:5432`, independently of the host `DATABASE_URL` setting.

Run these commands in your normal host terminal. No sandbox port publishing or Vite server is needed. The build copies source files explicitly and excludes `.env`; it does not bake the TMDB token into either image or the browser bundle. The current app foundation does not yet require that token at runtime.

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

`node-pg-migrate` applies pending migrations transactionally and records them in `public.pgmigrations`. The first migration creates the `upcoming` schema for future app tables. Running the command again is safe. Migration files live in `migrations/`; add a new migration instead of editing one that has already been applied. Do not run destructive rollback commands against user data.

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

This runs TypeScript, ESLint, ten tests (API/configuration plus TMDB date regressions), and the production build. Tests do not need a token or database. CI also applies migrations twice against a temporary PostgreSQL service. `npm run format` formats source and configuration files.

`/api/health` tests process liveness; `/api/ready` tests database connectivity and returns 503 on failure without exposing connection details. This readiness endpoint does not yet verify the application schema version.

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
