# Application foundation

## Repository boundaries

- `AbhinavBajpai/upcoming-frontend`: React, TypeScript, Vite, client routes, components, styles and browser tests.
- `AbhinavBajpai/upcoming-backend`: Express REST API, PostgreSQL access/migrations, TMDB import tooling and local Compose configuration.

Clone them as siblings. Each repository owns its dependency lockfile and CI workflow. `npm run dev:all` in the backend is a convenience entry point for both repositories; each remains independently buildable.

## Runtime

```text
Development
Browser → Vite :5173 → /api proxy → Express :3000 → PostgreSQL :55432

Production build
Browser → Express → static React assets + /api → PostgreSQL

Planned home deployment (UP-13)
Browser → existing Cloudflare Tunnel → Express container → private PostgreSQL
```

The static frontend is a build artifact consumed by the backend deployment. We do not need a second production web server. The development proxy and production same-origin layout allow relative API URLs and a future cookie session without a cross-origin authentication design.

## Database

Use `pg` with a bounded connection pool and `node-pg-migrate` for explicit versioned migrations. This keeps the relational model and SQL visible without introducing an ORM before film/release and friendship queries are designed. The migrations create the `upcoming` schema with film, release and sync-run tables. The one-shot sync command fills them from TMDB.

PostgreSQL 17 runs in Compose for local testing. Its development credentials are deliberately local-only, and its published port binds to loopback. The existing TMDB token stays in the backend `.env`; startup does not require it and the frontend never receives it.

## Quality checks

- Strict TypeScript, ESLint, Prettier and separate production builds.
- API tests cover liveness/readiness separation, controlled failures, SPA deep links, missing assets and unknown API routes.
- Frontend tests cover route navigation, direct links and focus transfer.
- Playwright covers desktop and mobile navigation, reloads and horizontal overflow.
- CI applies database migrations twice to detect basic migration/idempotency failures.
- Existing TMDB date regressions remain part of the backend test command.

## Deliberate limits of this slice

The monthly API and responsive calendar are implemented, including revival dates and external film links. There are no working account, star or friendship actions yet. `/api/ready` checks connectivity, not schema compatibility. A local multi-stage app image and Compose stack are available. Home-server deployment, secret provisioning and backup automation remain UP-13.

UP-03–06 provide catalogue import and monthly browsing. The next slice is [the authentication proposal](authentication.md) in UP-07, followed by accounts (UP-08) and stars (UP-09).
