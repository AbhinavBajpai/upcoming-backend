import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../../src/database.js";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/service.js";
import { readAuthConfig } from "../../src/auth/config.js";
import { starStore } from "../../src/stars/store.js";
import { syncCatalog } from "../../src/catalog/sync.js";
import type { FilmSnapshot } from "../../src/catalog/types.js";
import { monthWindows } from "../../src/catalog/dates.js";

const url = process.env.TEST_DATABASE_URL;
test("private stars and changing release dates", { skip: !url }, async (t) => {
  const pool = createDatabase(url!);
  let isolated = false;
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
    isolated = true;
    await pool.query(
      "TRUNCATE auth_user, auth_rate_limit, upcoming.stars, upcoming.releases, upcoming.films, upcoming.sync_runs CASCADE",
    );
    const config = readAuthConfig({ AUTH_BASE_URL: "http://localhost:3000" });
    const auth = createAuth(pool, config, async () => {});
    const store = starStore(pool);
    const now = new Date("2026-09-04T23:30:00Z"); // September 5 in London.
    const app = createApp({
      checkDatabase: async () => {},
      accounts: { auth, config },
      stars: store,
      clock: () => now,
    });
    async function account(email: string) {
      const agent = request.agent(app);
      await agent
        .post("/api/auth/sign-up/email")
        .set("Origin", config.origin)
        .send({
          name: "Film Friend",
          email,
          password: "long-enough-test-password",
        })
        .expect(200);
      // Verification itself is exercised by the account lifecycle suite.
      await pool.query(
        'UPDATE auth_user SET "emailVerified"=true WHERE email=$1',
        [email],
      );
      await agent
        .post("/api/auth/sign-in/email")
        .set("Origin", config.origin)
        .send({ email, password: "long-enough-test-password" })
        .expect(200);
      return agent;
    }
    const alice = await account("star-alice@example.test"),
      bob = await account("star-bob@example.test");
    const aliceId = (await alice.get("/api/me")).body.user.id;
    const films: FilmSnapshot[] = [
      {
        tmdbId: 101,
        title: "Revival",
        posterPath: null,
        imdbId: "tt1234567",
        releases: [
          { country: "GB", type: 3, date: "1971-07-25" },
          { country: "GB", type: 3, date: "2026-10-30" },
          { country: "GB", type: 3, date: "2026-11-01" },
        ],
      },
      {
        tmdbId: 102,
        title: "Today",
        posterPath: null,
        imdbId: null,
        releases: [
          { country: "GB", type: 2, date: "2026-09-05" },
          { country: "GB", type: 3, date: "2026-09-08" },
        ],
      },
      {
        tmdbId: 103,
        title: "Released",
        posterPath: null,
        imdbId: null,
        releases: [
          { country: "GB", type: 3, date: "2026-09-01" },
          { country: "GB", type: 3, date: "2026-08-01" },
        ],
      },
      {
        tmdbId: 104,
        title: "Unknown",
        posterPath: null,
        imdbId: null,
        releases: [
          { country: "US", type: 3, date: "2026-09-07" },
          { country: "GB", type: 4, date: "2026-09-07" },
          { country: "GB", type: 3, date: null },
        ],
      },
    ];
    const source = {
      discover: async () => films.map((f) => f.tmdbId),
      film: async (id: number) =>
        structuredClone(films.find((f) => f.tmdbId === id)!),
    };
    await syncCatalog(pool, source, monthWindows("2026-09", 2));
    const rows = (
      await pool.query<{ id: string; tmdb_id: number }>(
        "SELECT id,tmdb_id FROM upcoming.films ORDER BY tmdb_id",
      )
    ).rows;
    const id = rows[0]!.id;
    const change = (
      agent: typeof alice,
      filmId: string,
      method: "put" | "delete" = "put",
    ) =>
      agent[method]("/api/stars/" + filmId)
        .set("Origin", config.origin)
        .send({});
    await t.test(
      "requires a verified session, same origin, and server-owned identity",
      async () => {
        await request(app).get("/api/stars").expect(401);
        await request(app)
          .put("/api/stars/" + id)
          .send({})
          .expect(401);
        await alice
          .put("/api/stars/" + id)
          .send({})
          .expect(403);
        await alice
          .put("/api/stars/" + id)
          .set("Origin", "https://evil.example")
          .send({})
          .expect(403);
        await bob
          .put("/api/stars/" + id)
          .set("Origin", config.origin)
          .send({ userId: aliceId })
          .expect(400);
        await change(alice, "invalid").expect(400);
        await change(alice, "00000000-0000-4000-8000-000000000000").expect(404);
        await change(
          alice,
          "00000000-0000-4000-8000-000000000000",
          "delete",
        ).expect(200);
      },
    );
    await t.test(
      "repeated concurrent saves create one private star and deletes are idempotent",
      async () => {
        await Promise.all(
          Array.from({ length: 6 }, () => change(alice, id).expect(200)),
        );
        assert.equal((await alice.get("/api/stars")).body.films.length, 1);
        assert.equal((await bob.get("/api/stars")).body.films.length, 0);
        await change(bob, id, "delete").expect(200);
        assert.equal((await alice.get("/api/stars")).body.films.length, 1);
        await change(bob, id).expect(200);
        await Promise.all(
          Array.from({ length: 4 }, () =>
            change(alice, id, "delete").expect(200),
          ),
        );
        assert.equal((await alice.get("/api/stars")).body.films.length, 0);
        assert.equal((await bob.get("/api/stars")).body.films.length, 1);
        // Overlapping clients are resolved by database execution order; a final explicit PUT converges.
        await Promise.all([change(alice, id), change(alice, id, "delete")]);
        await change(alice, id).expect(200);
        assert.equal((await alice.get("/api/stars")).body.films.length, 1);
      },
    );
    await t.test(
      "lists earliest upcoming GB limited or wide theatrical releases, most recent past dates and TBC separately",
      async () => {
        for (const row of rows) await change(alice, row.id).expect(200);
        const response = await alice.get("/api/stars").expect(200);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.body.today, "2026-09-05");
        assert.deepEqual(
          response.body.films.map(
            (f: {
              title: string;
              releaseDate: string | null;
              section: string;
              isRevival: boolean;
            }) => [f.title, f.releaseDate, f.section, f.isRevival],
          ),
          [
            ["Today", "2026-09-05", "upcoming", false],
            ["Revival", "2026-10-30", "upcoming", true],
            ["Released", "2026-09-01", "released", true],
            ["Unknown", null, "tbc", false],
          ],
        );
      },
    );
    await t.test(
      "imports refresh stars outside discovery and preserve them after date withdrawal",
      async () => {
        source.discover = async () => [];
        films[0]!.releases = [{ country: "GB", type: 3, date: "2028-10-30" }];
        await syncCatalog(pool, source, monthWindows("2026-09", 1));
        let star = (await store.list(aliceId, now)).films.find(
          (f) => f.id === id,
        )!;
        assert.equal(star.releaseDate, "2028-10-30");
        films[0]!.releases = [];
        await syncCatalog(pool, source, monthWindows("2026-09", 1));
        star = (await store.list(aliceId, now)).films.find((f) => f.id === id)!;
        assert.equal(star.releaseDate, null);
        assert.equal(star.section, "tbc");
        assert.equal((await store.list(aliceId, now)).films.length, 4);
      },
    );
  } finally {
    if (isolated)
      await pool.query(
        "TRUNCATE auth_user, auth_rate_limit, upcoming.stars, upcoming.releases, upcoming.films, upcoming.sync_runs CASCADE",
      );
    await pool.end();
  }
});
