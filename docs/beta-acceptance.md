# Friend beta acceptance (UP-15)

Status: tooling and checklist prepared. Public-host checks, real mail delivery, server restart, off-server restore and owner/browser sign-off remain pending UP-13/14/21/22. Do not run synthetic fixtures or destructive failure experiments against live accounts.

## Repeatable checks

`node scripts/beta-smoke.mjs https://upcoming.crashpalace.uk` checks public readiness, the releases API, signed-out account access and SPA routes. It is read-only and sends no email. It deliberately does not count a Cloudflare challenge/Access login page as success.

The existing backend integration suite covers authorization, disconnect races and catalogue changes/failure reconciliation; the frontend's Playwright CI covers account flows, mutual friendships, watch lists, friend indicators and desktop/mobile calendar navigation. These are isolated tests and complement, rather than replace, the live tunnel/mail check.

For query timings on 500 fictional users, 2,000 films and 50,000 stars, migrate a dedicated **empty** `upcoming_test` database and run `TEST_DATABASE_URL=... node scripts/beta-benchmark.mjs` after building. It refuses other database names or existing users/films, never clears data, sends no mail and leaves fixtures available for dump/restore testing. Results are sequential warm query timings, not HTTP latency, concurrency capacity or an SLA. Measure again on Ubuntu before drawing hosting conclusions.

## Hosted acceptance record

Record date, backend/frontend commits, device/browser and pass/fail for each item. Do not attach account tokens or private messages.

- [ ] Public HTTPS, readiness, deep links and refresh work through the actual tunnel.
- [ ] Signup, received verification, sign-in, sign-out and received password reset work in an owner-controlled inbox; expired/replayed links fail.
- [ ] Current/next/previous month, filtering and cross-month suggestions preserve navigation state.
- [ ] Want to watch persists across refresh and a second device. Saved ticket styling and IMDb/Letterboxd destinations work.
- [ ] With A/B/C accounts, A–B and B–C connections do not expose C's interest to A. Pending requests expose no private watch list.
- [ ] Accept, decline, cancel and disconnect work; removing B blocks fresh list/interest API reads and removes stale private indicators from A's UI.
- [ ] Desktop keyboard and narrow mobile layouts work; focus changes retain authorized friend tags; date rail and forms remain usable.
- [ ] In isolated staging, postponed and withdrawn releases retain stars, and a failed sync leaves the previous committed catalogue usable.
- [ ] Restart app/database and reboot Ubuntu during a planned test; services recover and stars/friendships persist. Confirm other hosted apps still work.
- [ ] Complete an off-server restore drill and verify representative accounts, stars and friendships; record recovery time and snapshot age.
- [ ] Record server HTTP/query timings and measured dump size, plus any owner-observed bottlenecks.
- [ ] Choose an owner-visible failure notification and external availability check; deliberately fail a staging backup/sync to verify visibility.

Known limits: single-server availability, TMDB catalogue completeness, nightly-backup data loss window, 90 account-email attempts per UTC day, and public-test hosting/mail/restore checks still pending. Invite the first friends only after the hosted acceptance record is complete; capture feedback directly with the owner and track concrete defects on the board.

## Preparation results — 6 September 2026

Synthetic fixture: 500 users and credential records, 2,000 films/releases, 50,000 stars and 50 accepted friendships. PostgreSQL occupied about 15.8 MiB; the compressed dump was 352,012 bytes (344 KiB). Repetitive synthetic names and placeholder credential hashes compress much better than real data, so this is an example, not a forecast. Allow megabytes to tens of megabytes initially and measure the real catalogue.

| Warm database query           | p50     | p95     |
| ----------------------------- | ------- | ------- |
| Monthly calendar              | 1.74 ms | 2.63 ms |
| Cross-month search            | 2.96 ms | 3.38 ms |
| 100-film watch list           | 1.10 ms | 1.56 ms |
| Friend interest for 100 films | 1.07 ms | 1.36 ms |

Thirty sequential samples per query on the development sandbox; excludes HTTP, authentication, network latency and concurrent load. No indexing change was justified by this run.

Local validation: production image build and both ingress configuration checks passed; PostgreSQL has no published port. Read-only smoke passed before and after app/database restart, with all 50,000 stars and 50 friendships preserved. Backup, retention and isolated restore passed through Restic/rclone using a temporary **local test backend**, with all fixture counts restored and a full Restic data read passing. This does not verify a Dropbox upload. Fresh sync health passed and a deliberately stale sync failed as expected. All 30 backend unit/API/script tests, typecheck, lint and build passed. Ubuntu systemd timers and public mail/tunnel flows have not been exercised here.
