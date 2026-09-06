// Synthetic data in a dedicated, empty test database only. No external services.
import assert from "node:assert/strict";
import pg from "pg";
import { readCalendar } from "../dist/catalog/calendar.js";
import { searchReleases } from "../dist/catalog/search.js";
import { starStore } from "../dist/stars/store.js";
import { friendStore } from "../dist/friends/store.js";
const url = process.env.TEST_DATABASE_URL;
assert.ok(
  url && new URL(url).pathname === "/upcoming_test",
  "Use upcoming_test",
);
const pool = new pg.Pool({ connectionString: url });
try {
  assert.equal(
    (await pool.query("SELECT current_database() name")).rows[0].name,
    "upcoming_test",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM auth_user)+(SELECT count(*) FROM upcoming.films) AS n",
      )
    ).rows[0].n,
    "0",
    "Benchmark needs an empty, migrated test DB; it never clears existing data",
  );
  await pool.query(`INSERT INTO auth_user(id,name,email,"emailVerified")
    SELECT 'beta-'||lpad(n::text,4,'0'),'Beta User '||n,'beta-'||n||'@example.test',true FROM generate_series(1,500) n;
    INSERT INTO upcoming.films(tmdb_id,title,source_refreshed_at)
    SELECT 1900000000+n,'Beta Film '||n,now() FROM generate_series(1,2000) n;
    INSERT INTO upcoming.releases(film_id,country,release_type,release_date,source_refreshed_at)
    SELECT id,'GB',3,date '2026-09-01'+(tmdb_id%210),now() FROM upcoming.films;
    INSERT INTO upcoming.stars(user_id,film_id)
    SELECT u.id,f.id FROM auth_user u CROSS JOIN upcoming.films f
    WHERE (f.tmdb_id+substring(u.id from 6)::int)%20=0;
    INSERT INTO upcoming.friendships(user_low,user_high,requester_id,status,accepted_at)
    SELECT 'beta-0001',id,'beta-0001','accepted',now() FROM auth_user WHERE id>'beta-0001' AND id<='beta-0051';
    INSERT INTO auth_account(id,issuer,"accountId","providerId","userId","updatedAt",password)
    SELECT id,'beta',id,'credential',id,now(),'synthetic-not-a-valid-password-hash' FROM auth_user;
    INSERT INTO upcoming.sync_runs(status,window_start,window_end,completed_at)
    VALUES('succeeded','2026-09-01','2027-03-31',now());
    ANALYZE;`);
  const ids = (
    await pool.query("SELECT id FROM upcoming.films ORDER BY tmdb_id LIMIT 100")
  ).rows.map((r) => r.id);
  const now = new Date("2026-09-06T12:00:00Z");
  for (const [name, run] of [
    ["calendar", () => readCalendar(pool, "2026-09", now)],
    ["search", () => searchReleases(pool, "Beta Film", "2026-09", now)],
    ["watchlist", () => starStore(pool).list("beta-0001", now)],
    ["friend-interest-100", () => friendStore(pool).interest("beta-0001", ids)],
  ]) {
    await run();
    const timings = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      await run();
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        name,
        samples: 30,
        p50ms: +timings[14].toFixed(2),
        p95ms: +timings[28].toFixed(2),
      }),
    );
  }
  console.log(
    JSON.stringify({
      fixture: { users: 500, films: 2000, stars: 50000, friendsForViewer: 50 },
      databaseBytes: (
        await pool.query(
          "SELECT pg_database_size(current_database())::text bytes",
        )
      ).rows[0].bytes,
    }),
  );
} finally {
  await pool.end();
}
