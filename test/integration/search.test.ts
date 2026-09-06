import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { createDatabase } from "../../src/database.js";
import { searchReleases } from "../../src/catalog/search.js";
import { readCalendar } from "../../src/catalog/calendar.js";
import { syncCatalog } from "../../src/catalog/sync.js";
import { monthWindows } from "../../src/catalog/dates.js";

const url = process.env.TEST_DATABASE_URL;
test(
  "cross-month search uses calendar dates, history bounds and bounded literal matching",
  { skip: !url },
  async () => {
    const pool = createDatabase(url!);
    try {
      assert.equal(
        (await pool.query("SELECT current_database() AS name")).rows[0].name,
        "upcoming_test",
      );
      await runner({
        databaseUrl: url!,
        direction: "up",
        migrationsTable: "pgmigrations",
        dir: fileURLToPath(new URL("../../migrations", import.meta.url)),
        log: () => {},
      });
      await pool.query(
        "TRUNCATE upcoming.stars, upcoming.releases, upcoming.films, upcoming.sync_runs",
      );
      await syncCatalog(
        pool,
        {
          discover: async () => Array.from({ length: 23 }, (_, i) => i + 1),
          film: async (id) => ({
            tmdbId: id,
            title: id === 1 ? "The Devils 100%_" : `Other film ${id}`,
            posterPath: null,
            imdbId: null,
            releases:
              id === 1
                ? [
                    { country: "GB", type: 3, date: "1971-07-25" },
                    { country: "GB", type: 3, date: "2026-08-10" },
                    { country: "GB", type: 3, date: "2026-09-15" },
                    { country: "GB", type: 3, date: "2026-10-30" },
                    { country: "GB", type: 3, date: "2026-10-31" },
                    { country: "GB", type: 2, date: "2026-11-10" },
                    { country: "US", type: 3, date: "2026-12-10" },
                    { country: "GB", type: 4, date: "2027-01-10" },
                    { country: "GB", type: 3, date: null },
                    { country: "GB", type: 3, date: "2027-04-10" },
                  ]
                : [{ country: "GB", type: 3, date: "2026-10-01" }],
          }),
        },
        monthWindows("2026-08", 1),
      );
      const now = new Date("2026-09-05T12:00:00Z");
      const found = await searchReleases(pool, "dEvIlS", "2026-09", now);
      assert.deepEqual(
        found.matches.map((f) => f.releaseDate),
        ["2026-08-10", "2026-10-30", "2026-11-10"],
      );
      assert.equal(found.hasMore, false);
      const october = await readCalendar(pool, "2026-10", now);
      assert.equal(
        october.films.find((f) => f.id === found.matches[1]!.filmId)!
          .releaseDate,
        found.matches[1]!.releaseDate,
      );
      assert.equal(
        (await searchReleases(pool, "%_", "2026-09", now)).matches.length,
        3,
      );
      assert.equal(
        (await searchReleases(pool, "missing", "2026-09", now)).matches.length,
        0,
      );
      const bounded = await searchReleases(pool, "Other", "2026-09", now);
      assert.equal(bounded.matches.length, 20);
      assert.equal(bounded.hasMore, true);
    } finally {
      await pool.end();
    }
  },
);
