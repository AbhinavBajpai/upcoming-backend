import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../../src/database.js";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/service.js";
import { readAuthConfig } from "../../src/auth/config.js";
import {
  friendStore,
  FriendError,
  type FriendAction,
} from "../../src/friends/store.js";
import { starStore } from "../../src/stars/store.js";
const url = process.env.TEST_DATABASE_URL;
test(
  "mutual friendship permissions and concurrent transitions",
  { skip: !url },
  async (t) => {
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
      const auth = createAuth(pool, config, async () => {}),
        store = friendStore(pool);
      const now = new Date("2026-09-06T12:00:00Z");
      const app = createApp({
        checkDatabase: async () => {},
        accounts: { auth, config },
        friends: store,
        stars: starStore(pool),
        clock: () => now,
      });
      async function account(name: string) {
        const agent = request.agent(app),
          email = name.toLowerCase() + "@example.test",
          password = "long-friend-test-password";
        await agent
          .post("/api/auth/sign-up/email")
          .set("Origin", config.origin)
          .send({ name, email, password })
          .expect(200);
        await pool.query(
          'UPDATE auth_user SET "emailVerified"=true WHERE email=$1',
          [email],
        );
        await agent
          .post("/api/auth/sign-in/email")
          .set("Origin", config.origin)
          .send({ email, password })
          .expect(200);
        return {
          agent,
          id: (await agent.get("/api/me")).body.user.id as string,
        };
      }
      const alice = await account("Alice"),
        bob = await account("Bob"),
        carol = await account("Carol");
      const film = (
        await pool.query(
          "INSERT INTO upcoming.films(tmdb_id,title,source_refreshed_at) VALUES(777,'Private Film',now()) RETURNING id",
        )
      ).rows[0].id;
      await pool.query(
        "INSERT INTO upcoming.releases(film_id,country,release_type,release_date,source_refreshed_at) VALUES($1,'GB',3,'2026-10-01',now())",
        [film],
      );
      await starStore(pool).set(alice.id, film, true);
      await starStore(pool).set(bob.id, film, true);
      const post = (who: typeof alice, path: string, body: object = {}) =>
        who.agent
          .post("/api/friends" + path)
          .set("Origin", config.origin)
          .send(body);
      const act = (who: typeof alice, id: string, action: FriendAction) =>
        post(who, "/relationships/" + id + "/" + action);
      const watch = (who: typeof alice, target: string) =>
        who.agent.get("/api/friends/profiles/" + target + "/watch-list");
      const reset = () => pool.query("TRUNCATE upcoming.friendships");
      const pending = async () => {
        await reset();
        return (await store.request(alice.id, bob.id)).relationshipId!;
      };
      await t.test(
        "verified sessions and same-origin empty JSON are required; profiles expose only public identity",
        async () => {
          await request(app).get("/api/friends").expect(401);
          await request(app)
            .post("/api/friends/requests/" + bob.id)
            .send({})
            .expect(401);
          await alice.agent
            .post("/api/friends/requests/" + bob.id)
            .send({})
            .expect(403);
          await alice.agent
            .post("/api/friends/requests/" + bob.id)
            .set("Origin", "https://evil.example")
            .send({})
            .expect(403);
          await post(alice, "/requests/" + bob.id, { userId: carol.id }).expect(
            400,
          );
          await post(alice, "/requests/" + alice.id).expect(400);
          await post(alice, "/requests/unknown-profile").expect(404);
          await post(alice, "/relationships/not-a-uuid/accept").expect(400);
          const response = await alice.agent
            .get("/api/friends/profiles/" + bob.id)
            .expect(200);
          assert.equal(response.headers["cache-control"], "no-store");
          assert.deepEqual(response.body, {
            profile: {
              id: bob.id,
              displayName: "Bob",
              relationshipId: null,
              relationship: "none",
            },
          });
          await pool.query(
            'UPDATE auth_user SET "emailVerified"=false WHERE id=$1',
            [carol.id],
          );
          await carol.agent.get("/api/friends").expect(401);
          await post(alice, "/requests/" + carol.id).expect(404);
          await pool.query(
            'UPDATE auth_user SET "emailVerified"=true WHERE id=$1',
            [carol.id],
          );
        },
      );
      await t.test(
        "crossed and repeated requests never grant access or change the original sender",
        async () => {
          await reset();
          await Promise.all(
            Array.from({ length: 12 }, (_, i) =>
              store.request(
                i % 2 ? alice.id : bob.id,
                i % 2 ? bob.id : alice.id,
              ),
            ),
          );
          const rows = (await pool.query("SELECT * FROM upcoming.friendships"))
            .rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].status, "pending");
          const sender = rows[0].requester_id;
          await store.request(alice.id, bob.id);
          await store.request(bob.id, alice.id);
          assert.equal(
            (await pool.query("SELECT requester_id FROM upcoming.friendships"))
              .rows[0].requester_id,
            sender,
          );
          await watch(alice, bob.id).expect(404);
          await watch(bob, alice.id).expect(404);
          await watch(carol, bob.id).expect(404);
          const a = await alice.agent.get("/api/friends").expect(200);
          assert.equal(a.body.accepted.length, 0);
          assert.equal(a.body.incoming.length + a.body.outgoing.length, 1);
          assert.ok(!JSON.stringify(a.body).includes("Private Film"));
        },
      );
      await t.test(
        "complete pending action matrix: recipient accepts/declines, sender cancels, outsiders cannot act",
        async () => {
          for (const who of [alice, bob, carol])
            for (const operation of [
              "accept",
              "decline",
              "cancel",
              "remove",
            ] as const) {
              const id = await pending();
              const allowed =
                (who === bob &&
                  (operation === "accept" || operation === "decline")) ||
                (who === alice && operation === "cancel");
              await act(who, id, operation).expect(allowed ? 200 : 409);
              const rows = (
                await pool.query("SELECT status FROM upcoming.friendships")
              ).rows;
              if (!allowed) assert.deepEqual(rows, [{ status: "pending" }]);
              else if (operation === "accept")
                assert.deepEqual(rows, [{ status: "accepted" }]);
              else assert.deepEqual(rows, []);
            }
        },
      );
      await t.test(
        "acceptance grants mutual access, pending outsiders cannot read, either friend can disconnect",
        async () => {
          for (const remover of [alice, bob]) {
            const id = await pending();
            await act(bob, id, "accept").expect(200);
            await act(bob, id, "accept").expect(200);
            for (const [viewer, target] of [
              [alice, bob],
              [bob, alice],
            ] as const) {
              const response = await watch(viewer, target.id).expect(200);
              assert.equal(response.body.profile.id, target.id);
              assert.equal(response.body.films[0].id, film);
              assert.equal(response.body.today, "2026-09-06");
              assert.equal(response.headers["cache-control"], "no-store");
              assert.deepEqual(Object.keys(response.body.profile).sort(), [
                "displayName",
                "id",
              ]);
              assert.equal(
                (await viewer.agent.get("/api/friends")).body.accepted.length,
                1,
              );
            }
            await store.request(carol.id, bob.id);
            await watch(carol, bob.id).expect(404);
            await act(alice, id, "cancel").expect(409);
            await act(bob, id, "decline").expect(409);
            await act(carol, id, "remove").expect(409);
            await act(remover, id, "remove").expect(200);
            await watch(alice, bob.id).expect(404);
            await watch(bob, alice.id).expect(404);
            assert.equal(
              (await alice.agent.get("/api/friends")).body.accepted.length,
              0,
            );
          }
        },
      );
      await t.test(
        "stale actions cannot accept or delete a replacement request",
        async () => {
          const old = await pending();
          await store.act(alice.id, old, "cancel");
          const next = (await store.request(alice.id, bob.id)).relationshipId!;
          assert.notEqual(next, old);
          await act(bob, old, "accept").expect(409);
          await act(alice, old, "cancel").expect(409);
          await act(bob, old, "remove").expect(409);
          assert.equal(
            (await store.profile(bob.id, alice.id)).relationship,
            "incoming",
          );
          await watch(alice, bob.id).expect(404);
        },
      );
      await t.test(
        "concurrent accept/cancel and accept/remove respect committed row transitions",
        async () => {
          for (let i = 0; i < 8; i++) {
            const id = await pending();
            const [accept, cancel] = await Promise.allSettled([
              store.act(bob.id, id, "accept"),
              store.act(alice.id, id, "cancel"),
            ]);
            assert.notEqual(accept.status, cancel.status);
            const rows = (
              await pool.query("SELECT status FROM upcoming.friendships")
            ).rows;
            assert.deepEqual(
              rows,
              accept.status === "fulfilled" ? [{ status: "accepted" }] : [],
            );
          }
          for (let i = 0; i < 8; i++) {
            const id = await pending();
            const [accept, remove] = await Promise.allSettled([
              store.act(bob.id, id, "accept"),
              store.act(alice.id, id, "remove"),
            ]);
            assert.equal(accept.status, "fulfilled");
            assert.deepEqual(
              (await pool.query("SELECT status FROM upcoming.friendships"))
                .rows,
              remove.status === "fulfilled" ? [] : [{ status: "accepted" }],
            );
          }
        },
      );
      await t.test(
        "watch-list and interest reads waiting on disconnect cannot return private data after commit",
        async () => {
          const id = await pending();
          await store.act(bob.id, id, "accept");
          const connection = await pool.connect();
          try {
            await connection.query("BEGIN");
            await connection.query(
              "DELETE FROM upcoming.friendships WHERE id=$1",
              [id],
            );
            const reading = store.watchList(alice.id, bob.id, now).then(
              () => null,
              (error) => error,
            );
            const interestReading = store.interest(alice.id, [film]);
            let blocked = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const waiting = await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE ANY($1::text[])",
                [["%FOR SHARE OF f%", "%WITH accepted AS MATERIALIZED%"]],
              );
              if ((waiting.rowCount ?? 0) >= 2) {
                blocked = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.ok(
              blocked,
              "The read must reach the relationship lock before committing the disconnect",
            );
            await connection.query("COMMIT");
            const error = await reading;
            assert.ok(error instanceof FriendError);
            assert.equal(error.code, "WATCH_LIST_UNAVAILABLE");
            assert.deepEqual(await interestReading, {
              films: [{ filmId: film, friends: [] }],
            });
          } finally {
            await connection.query("ROLLBACK");
            connection.release();
          }
        },
      );
      await t.test(
        "batched interest follows only the viewer's accepted edges, including on another friend's list",
        async () => {
          await reset();
          const ab = (await store.request(alice.id, bob.id)).relationshipId!;
          const bc = (await store.request(bob.id, carol.id)).relationshipId!;
          await store.act(bob.id, ab, "accept");
          await store.act(carol.id, bc, "accept");
          await starStore(pool).set(carol.id, film, true);
          const other = (
            await pool.query(
              "INSERT INTO upcoming.films(tmdb_id,title,source_refreshed_at) VALUES(778,'Second private film',now()) RETURNING id",
            )
          ).rows[0].id;
          await starStore(pool).set(carol.id, other, true);
          const interest = (who: typeof alice, ids = [film, other]) =>
            who.agent
              .get("/api/friends/interest")
              .query({ filmIds: ids.join(",") });
          await request(app)
            .get("/api/friends/interest")
            .query({ filmIds: film })
            .expect(401);
          await alice.agent
            .get("/api/friends/interest")
            .query({ filmIds: film, userId: bob.id })
            .expect(400);
          await alice.agent.get("/api/friends/interest").expect(400);
          await alice.agent
            .get("/api/friends/interest")
            .query({ filmIds: "invalid" })
            .expect(400);
          await interest(alice, Array(101).fill(film)).expect(400);
          await alice.agent
            .get("/api/friends/interest")
            .query({ filmIds: [film, other] })
            .expect(400);
          const response = await interest(alice).expect(200);
          assert.equal(response.headers["cache-control"], "no-store");
          assert.deepEqual(response.body, {
            films: [
              { filmId: film, friends: [{ id: bob.id, displayName: "Bob" }] },
              { filmId: other, friends: [] },
            ],
          });
          assert.deepEqual((await interest(bob)).body, {
            films: [
              {
                filmId: film,
                friends: [
                  { id: alice.id, displayName: "Alice" },
                  { id: carol.id, displayName: "Carol" },
                ],
              },
              {
                filmId: other,
                friends: [{ id: carol.id, displayName: "Carol" }],
              },
            ],
          });
          assert.deepEqual((await interest(carol)).body.films[0].friends, [
            { id: bob.id, displayName: "Bob" },
          ]);
          // Viewing Bob's list does not change whose relationships govern indicators.
          await watch(alice, bob.id).expect(200);
          assert.ok(
            !JSON.stringify((await interest(alice)).body).includes(carol.id),
          );
          const ac = (await store.request(alice.id, carol.id)).relationshipId!;
          assert.ok(
            !JSON.stringify((await interest(alice)).body).includes(carol.id),
          );
          await store.act(carol.id, ac, "decline");
          assert.equal(
            (await interest(alice, [film, film.toUpperCase()])).body.films
              .length,
            1,
          );
          await starStore(pool).set(bob.id, film, false);
          assert.deepEqual((await interest(alice)).body.films[0].friends, []);
          await starStore(pool).set(bob.id, film, true);
          await pool.query(
            'UPDATE auth_user SET "emailVerified"=false WHERE id=$1',
            [bob.id],
          );
          assert.deepEqual((await interest(alice)).body.films[0].friends, []);
          await pool.query(
            'UPDATE auth_user SET "emailVerified"=true WHERE id=$1',
            [bob.id],
          );
          await store.act(alice.id, ab, "remove");
          assert.deepEqual((await interest(alice)).body.films[0].friends, []);
          await interest(alice, [
            "00000000-0000-4000-8000-000000000000",
          ]).expect(200);
        },
      );
      await t.test(
        "database constraints prevent self-pairs and reversed duplicates; deleting a user cleans up relationships",
        async () => {
          await pending();
          await assert.rejects(
            pool.query(
              "INSERT INTO upcoming.friendships(user_low,user_high,requester_id) VALUES($1,$1,$1)",
              [alice.id],
            ),
            { code: "23514" },
          );
          const [low, high] = [alice.id, bob.id].sort();
          await assert.rejects(
            pool.query(
              "INSERT INTO upcoming.friendships(user_low,user_high,requester_id) VALUES($1,$2,$1)",
              [high, low],
            ),
            { code: "23514" },
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO upcoming.friendships(user_low,user_high,requester_id) VALUES($1,$2,$1)",
              [low, high],
            ),
            { code: "23505" },
          );
          await pool.query("DELETE FROM auth_user WHERE id=$1", [bob.id]);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM upcoming.friendships",
              )
            ).rows[0].n,
            0,
          );
        },
      );
    } finally {
      if (isolated)
        await pool.query(
          "TRUNCATE auth_user, auth_rate_limit, upcoming.stars, upcoming.releases, upcoming.films, upcoming.sync_runs CASCADE",
        );
      await pool.end();
    }
  },
);
