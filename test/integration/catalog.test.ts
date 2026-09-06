import { readCalendar } from "../../src/catalog/calendar.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { createDatabase } from "../../src/database.js";
import { monthWindows } from "../../src/catalog/dates.js";
import { syncCatalog, SYNC_LOCK } from "../../src/catalog/sync.js";
import {
  SourceError,
  type FilmSnapshot,
  type FilmSource,
} from "../../src/catalog/types.js";

const url = process.env.TEST_DATABASE_URL;
test("catalog database integration", { skip: !url }, async (t) => {
  // This suite clears its fixture tables. Refuse any database except the dedicated test DB.
  const pool = createDatabase(url!);
  try {
    const name = await pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    assert.equal(
      name.rows[0]!.name,
      "upcoming_test",
      "Use the isolated upcoming_test database",
    );
    for (let i = 0; i < 2; i++)
      await runner({
        databaseUrl: url!,
        direction: "up",
        migrationsTable: "pgmigrations",
        dir: fileURLToPath(new URL("../../migrations", import.meta.url)),
        log: () => {},
      });
    const windows = monthWindows("2026-10", 1);
    let ids = [31767];
    const film: FilmSnapshot = {
      tmdbId: 31767,
      title: "The Devils",
      posterPath: null,
      imdbId: null,
      releases: [
        { country: "GB", type: 3, date: "1971-07-25" },
        { country: "GB", type: 3, date: "2026-10-30" },
      ],
    };
    const source: FilmSource = {
      discover: async () => ids,
      film: async () => structuredClone(film),
    };
    const clear = () =>
      pool.query(
        "TRUNCATE upcoming.stars, upcoming.releases, upcoming.films, upcoming.sync_runs",
      );
    await clear();
    await t.test(
      "repeated import preserves IDs and calendar date semantics; revivals remain queryable",
      async () => {
        await syncCatalog(pool, source, windows);
        const first = await pool.query("SELECT id FROM upcoming.films");
        const releases = await pool.query(
          "SELECT id FROM upcoming.releases ORDER BY release_date",
        );
        await syncCatalog(pool, source, windows);
        assert.deepEqual(
          (await pool.query("SELECT id FROM upcoming.films")).rows,
          first.rows,
        );
        assert.deepEqual(
          (
            await pool.query(
              "SELECT id FROM upcoming.releases ORDER BY release_date",
            )
          ).rows,
          releases.rows,
        );
        const calendar =
          await pool.query(`SELECT f.title, r.release_date::text AS date FROM upcoming.releases r
        JOIN upcoming.films f ON f.id=r.film_id WHERE country='GB' AND release_type IN (2,3)
        AND release_date BETWEEN '2026-10-01' AND '2026-10-31'`);
        assert.deepEqual(calendar.rows, [
          { title: "The Devils", date: "2026-10-30" },
        ]);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM upcoming.sync_runs WHERE status='succeeded'",
            )
          ).rows[0].n,
          2,
        );
      },
    );
    await t.test(
      "known films refresh even when absent from discovery; postponements preserve film identity",
      async () => {
        const before = (await pool.query("SELECT id FROM upcoming.films"))
          .rows[0].id;
        ids = [];
        film.releases = [{ country: "GB", type: 3, date: "2027-09-10" }];
        const result = await syncCatalog(pool, source, windows);
        assert.equal(result.discovered, 0);
        assert.equal(result.refreshed, 1);
        assert.equal(
          (await pool.query("SELECT id FROM upcoming.films")).rows[0].id,
          before,
        );
        assert.deepEqual(
          (
            await pool.query(
              "SELECT release_date::text AS date FROM upcoming.releases",
            )
          ).rows,
          [{ date: "2027-09-10" }],
        );
      },
    );
    await t.test(
      "explicit withdrawal clears obsolete events but preserves the film",
      async () => {
        film.releases = [];
        await syncCatalog(pool, source, windows);
        assert.equal(
          (await pool.query("SELECT count(*)::int AS n FROM upcoming.films"))
            .rows[0].n,
          1,
        );
        assert.equal(
          (await pool.query("SELECT count(*)::int AS n FROM upcoming.releases"))
            .rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "unknown dates remain nullable and database constraints prevent duplicates and invalid records",
      async () => {
        film.releases = [{ country: "GB", type: 3, date: null }];
        await syncCatalog(pool, source, windows);
        await syncCatalog(pool, source, windows);
        assert.equal(
          (await pool.query("SELECT count(*)::int AS n FROM upcoming.releases"))
            .rows[0].n,
          1,
        );
        const id = (await pool.query("SELECT id FROM upcoming.films")).rows[0]
          .id;
        await assert.rejects(
          pool.query(
            `INSERT INTO upcoming.releases(film_id,country,release_type,release_date,source_refreshed_at)
        VALUES($1,'GB',3,NULL,now())`,
            [id],
          ),
          (e: unknown) =>
            typeof e === "object" &&
            e !== null &&
            "code" in e &&
            e.code === "23505",
        );
        await assert.rejects(
          pool.query(
            `INSERT INTO upcoming.releases(film_id,country,release_type,source_refreshed_at)
        VALUES($1,'GB',9,now())`,
            [id],
          ),
        );
        await assert.rejects(
          pool.query(`INSERT INTO upcoming.releases(film_id,country,release_type,source_refreshed_at)
        VALUES(gen_random_uuid(),'GB',3,now())`),
        );
      },
    );
    await t.test(
      "upstream failure preserves the catalogue and last successful run; retry can recover",
      async () => {
        const before = (await pool.query("SELECT * FROM upcoming.films")).rows;
        const success = (
          await pool.query(
            "SELECT id FROM upcoming.sync_runs WHERE status='succeeded' ORDER BY completed_at DESC LIMIT 1",
          )
        ).rows;
        await assert.rejects(
          syncCatalog(
            pool,
            {
              discover: async () => [99],
              film: async () => {
                throw new SourceError("TMDB_HTTP_503");
              },
            },
            windows,
          ),
          /TMDB_HTTP_503/,
        );
        assert.deepEqual(
          (await pool.query("SELECT * FROM upcoming.films")).rows,
          before,
        );
        assert.deepEqual(
          (
            await pool.query(
              "SELECT id FROM upcoming.sync_runs WHERE status='succeeded' ORDER BY completed_at DESC LIMIT 1",
            )
          ).rows,
          success,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT error_code FROM upcoming.sync_runs WHERE status='failed'",
            )
          ).rows[0].error_code,
          "TMDB_HTTP_503",
        );
        await syncCatalog(pool, source, windows);
      },
    );
    await t.test(
      "database failure midway through saving rolls back earlier film updates",
      async () => {
        const before = (await pool.query("SELECT * FROM upcoming.films")).rows;
        await assert.rejects(
          syncCatalog(
            pool,
            {
              discover: async () => [31767, 999],
              film: async (id) =>
                id === 31767
                  ? { ...film, title: "Should roll back" }
                  : { ...film, tmdbId: id, title: "" },
            },
            windows,
          ),
          /SYNC_FAILED/,
        );
        assert.deepEqual(
          (await pool.query("SELECT * FROM upcoming.films")).rows,
          before,
        );
      },
    );
    await t.test(
      "overlapping imports skip without calling TMDB or creating a run",
      async () => {
        const lock = await pool.connect();
        try {
          await lock.query("SELECT pg_advisory_lock($1)", [SYNC_LOCK]);
          const result = await syncCatalog(
            pool,
            {
              discover: async () => {
                throw new Error("must not run");
              },
              film: source.film,
            },
            windows,
          );
          assert.equal(result.status, "skipped");
        } finally {
          await lock.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK]);
          lock.release();
        }
      },
    );
    await t.test(
      "next lock owner marks a killed run as interrupted and can proceed",
      async () => {
        await pool.query(
          `INSERT INTO upcoming.sync_runs(status,window_start,window_end) VALUES('running','2026-10-01','2026-10-31')`,
        );
        await syncCatalog(pool, source, windows);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM upcoming.sync_runs WHERE error_code='INTERRUPTED'",
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM upcoming.sync_runs WHERE status='running'",
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "monthly calendar filters regions/types, selects one revival event, and preserves stable ordering",
      async () => {
        await clear();
        const snapshots: FilmSnapshot[] = [
          {
            tmdbId: 1,
            title: "Alpha revival",
            posterPath: null,
            imdbId: null,
            releases: [
              { country: "GB", type: 3, date: "1971-07-25" },
              { country: "GB", type: 3, date: "2026-10-31" },
              { country: "GB", type: 3, date: "2026-10-30" },
            ],
          },
          {
            tmdbId: 2,
            title: "Bravo",
            posterPath: "/poster.jpg",
            imdbId: "tt1234567",
            releases: [
              { country: "GB", type: 3, date: "2026-10-30" },
              { country: "GB", type: 2, date: "2026-10-30" },
            ],
          },
          {
            tmdbId: 3,
            title: "Limited only",
            posterPath: null,
            imdbId: null,
            releases: [{ country: "GB", type: 2, date: "2026-10-15" }],
          },
          {
            tmdbId: 4,
            title: "US only",
            posterPath: null,
            imdbId: null,
            releases: [{ country: "US", type: 3, date: "2026-10-01" }],
          },
          {
            tmdbId: 5,
            title: "Unknown date",
            posterPath: null,
            imdbId: null,
            releases: [{ country: "GB", type: 3, date: null }],
          },
          {
            tmdbId: 6,
            title: "Boundary",
            posterPath: null,
            imdbId: null,
            releases: [
              { country: "GB", type: 3, date: "2026-09-30" },
              { country: "GB", type: 3, date: "2026-10-01" },
              { country: "GB", type: 3, date: "2026-11-01" },
            ],
          },
        ];
        const calendarSource: FilmSource = {
          discover: async () => snapshots.map((f) => f.tmdbId),
          film: async (id) => snapshots.find((f) => f.tmdbId === id)!,
        };
        await syncCatalog(pool, calendarSource, monthWindows("2026-09", 2));
        const clock = new Date("2026-09-05T12:00:00Z");
        const october = await readCalendar(pool, "2026-10", clock);
        assert.deepEqual(
          october.films.map((f) => [f.title, f.releaseDate, f.isRevival]),
          [
            ["Boundary", "2026-10-01", true],
            ["Limited only", "2026-10-15", false],
            ["Alpha revival", "2026-10-30", true],
            ["Bravo", "2026-10-30", false],
          ],
        );
        assert.equal(october.films[3]!.posterPath, "/poster.jpg");
        assert.equal(october.films[3]!.imdbId, "tt1234567");
        assert.equal(october.films[0]!.imdbId, null);
        assert.deepEqual(october.range, { from: "2026-09", to: "2027-03" });
        assert.equal(october.monthSynced, true);
        assert.ok(october.lastSuccessfulSync);
        const november = await readCalendar(pool, "2026-11", clock);
        assert.equal(november.monthSynced, false);
        assert.equal(november.films.length, 1);
        await syncCatalog(pool, calendarSource, monthWindows("2026-12", 1));
        const empty = await readCalendar(pool, "2026-12", clock);
        assert.equal(empty.monthSynced, true);
        assert.deepEqual(empty.films, []);
        const history = await readCalendar(
          pool,
          "2026-09",
          new Date("2026-10-01T12:00:00Z"),
        );
        assert.equal(history.range.from, "2026-09");
        await assert.rejects(
          readCalendar(pool, "1971-07", clock),
          /MONTH_OUT_OF_RANGE/,
        );
        await assert.rejects(
          readCalendar(pool, "2027-04", clock),
          /MONTH_OUT_OF_RANGE/,
        );
      },
    );
    await t.test(
      "fresh database reports an unsynced empty calendar without pretending the request failed",
      async () => {
        await clear();
        const empty = await readCalendar(
          pool,
          "2026-09",
          new Date("2026-09-05T12:00:00Z"),
        );
        assert.deepEqual(empty.films, []);
        assert.equal(empty.monthSynced, false);
        assert.equal(empty.lastSuccessfulSync, null);
        assert.equal(empty.today, "2026-09-05");
      },
    );
    await clear();
  } finally {
    await pool.end();
  }
});
