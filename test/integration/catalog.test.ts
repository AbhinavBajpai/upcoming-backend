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
        "TRUNCATE upcoming.releases, upcoming.films, upcoming.sync_runs",
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
        JOIN upcoming.films f ON f.id=r.film_id WHERE country='GB' AND release_type=3
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
    await clear();
  } finally {
    await pool.end();
  }
});
