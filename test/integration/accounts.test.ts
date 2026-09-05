import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../../src/database.js";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/service.js";
import { readAuthConfig } from "../../src/auth/config.js";
import { budgetedEmail, type AccountEmail } from "../../src/auth/email.js";
const url = process.env.TEST_DATABASE_URL;
test("account lifecycle and request protections", { skip: !url }, async (t) => {
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
      "TRUNCATE auth_user, auth_account, auth_session, auth_verification, auth_rate_limit, auth_email_limits CASCADE",
    );
    const config = readAuthConfig({ AUTH_BASE_URL: "http://localhost:3000" });
    const emails: AccountEmail[] = [];
    const auth = createAuth(pool, config, async (mail) => {
      emails.push(mail);
    });
    const app = createApp({
      checkDatabase: async () => {},
      accounts: { auth, config },
    });
    const post = (path: string, body: object, agent = request(app)) =>
      agent
        .post("/api/auth" + path)
        .set("Origin", config.origin)
        .send(body);
    const password = "a-long-test-password";
    async function clearLimits() {
      await pool.query("TRUNCATE auth_rate_limit");
    }
    async function signup(email: string) {
      await post("/sign-up/email", {
        name: "Cinema Friend",
        email,
        password,
        callbackURL: "/login?verified=1",
      }).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    async function verify(email: string) {
      const message = emails.findLast(
        (m) => m.to === email && m.kind === "verify",
      );
      assert.ok(message);
      const link = new URL(message.url);
      await request(app)
        .get(link.pathname + link.search)
        .expect(302);
    }
    const alice = request.agent(app),
      bob = request.agent(app);
    await t.test(
      "registration requires verification and retains private identity server-side",
      async () => {
        await request(app).get("/api/me").expect(401);
        await signup("alice@example.test");
        await post(
          "/sign-in/email",
          { email: "alice@example.test", password },
          alice,
        ).expect(403);
        await verify("alice@example.test");
        const login = await post(
          "/sign-in/email",
          { email: "alice@example.test", password },
          alice,
        ).expect(200);
        assert.match(String(login.headers["set-cookie"]), /HttpOnly/);
        assert.match(String(login.headers["set-cookie"]), /SameSite=Lax/i);
        const me = await alice.get("/api/me").expect(200);
        assert.deepEqual(Object.keys(me.body.user).sort(), [
          "displayName",
          "id",
        ]);
        assert.equal(me.body.user.displayName, "Cinema Friend");
      },
    );
    await t.test(
      "another session cannot update another user or bypass request origin checks",
      async () => {
        await signup("bob@example.test");
        await verify("bob@example.test");
        await post(
          "/sign-in/email",
          { email: "bob@example.test", password },
          bob,
        ).expect(200);
        const aliceId = (await alice.get("/api/me")).body.user.id;
        await post(
          "/update-user",
          { name: "Intruder", userId: aliceId },
          bob,
        ).expect(400);
        await bob
          .post("/api/auth/update-user")
          .set("Origin", "https://evil.example")
          .send({ name: "Intruder" })
          .expect(403);
        await bob
          .post("/api/auth/update-user")
          .send({ name: "Intruder" })
          .expect(403);
        await post("/update-user", { name: "Bob" }, bob).expect(200);
        assert.equal(
          (await alice.get("/api/me")).body.user.displayName,
          "Cinema Friend",
        );
        assert.equal((await bob.get("/api/me")).body.user.displayName, "Bob");
        await post("/sign-up/email", {
          name: "X",
          email: "bad@example.test",
          password,
          callbackURL: "https://evil.example",
        }).expect(403);
      },
    );
    await t.test(
      "reset tokens expire, are single-use, and revoke existing sessions",
      async () => {
        await clearLimits();
        const known = await post("/request-password-reset", {
          email: "alice@example.test",
          redirectTo: "/reset-password",
        }).expect(200);
        const unknown = await post("/request-password-reset", {
          email: "absent@example.test",
          redirectTo: "/reset-password",
        }).expect(200);
        assert.deepEqual(known.body, unknown.body);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const reset = emails.findLast(
          (m) => m.to === "alice@example.test" && m.kind === "reset",
        );
        assert.ok(reset);
        const link = new URL(reset.url);
        const token = link.pathname.split("/").at(-1)!;
        await post("/reset-password", {
          token: "bad-token",
          newPassword: "new-password-for-tests",
        }).expect(400);
        await post("/reset-password", {
          token,
          newPassword: "new-password-for-tests",
        }).expect(200);
        await post("/reset-password", {
          token,
          newPassword: "another-test-password",
        }).expect(400);
        await alice.get("/api/me").expect(401);
        await post(
          "/sign-in/email",
          { email: "alice@example.test", password },
          alice,
        ).expect(401);
        await post(
          "/sign-in/email",
          { email: "alice@example.test", password: "new-password-for-tests" },
          alice,
        ).expect(200);
        await post("/request-password-reset", {
          email: "alice@example.test",
          redirectTo: "/reset-password",
        }).expect(200);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const expired = emails.findLast((m) => m.kind === "reset")!;
        await pool.query(
          "UPDATE auth_verification SET \"expiresAt\"=now()-interval '1 second'",
        );
        await post("/reset-password", {
          token: new URL(expired.url).pathname.split("/").at(-1),
          newPassword: "another-test-password",
        }).expect(400);
      },
    );
    await t.test(
      "oversized and malformed auth JSON is bounded before the library",
      async () => {
        await post("/sign-in/email", {
          email: "a@example.test",
          password: "x".repeat(40000),
        }).expect(413);
        await request(app)
          .post("/api/auth/sign-in/email")
          .set("Origin", config.origin)
          .set("Content-Type", "application/json")
          .send("{")
          .expect(400);
      },
    );
    await t.test("sign-out and expiry invalidate server sessions", async () => {
      await post("/sign-out", {}, alice).expect(200);
      await alice.get("/api/me").expect(401);
      await pool.query(
        "UPDATE auth_session SET \"expiresAt\"=now()-interval '1 second'",
      );
      await bob.get("/api/me").expect(401);
    });
    await t.test(
      "rate limits ignore client-supplied forwarding headers",
      async () => {
        await clearLimits();
        for (let i = 0; i < 10; i++)
          await request(app)
            .post("/api/auth/sign-in/email")
            .set("Origin", config.origin)
            .set("x-forwarded-for", `192.0.2.${i}`)
            .set("x-upcoming-client-ip", `192.0.2.${i}`)
            .send({ email: "absent@example.test", password })
            .expect(401);
        await post("/sign-in/email", {
          email: "absent@example.test",
          password,
        }).expect(429);
      },
    );
    await t.test(
      "email cooldown and budget are atomic across concurrent sends",
      async () => {
        let sent = 0;
        const deliver = budgetedEmail(pool, config.secret, async () => {
          sent++;
        });
        await Promise.all(
          Array.from({ length: 5 }, () =>
            deliver({
              to: "quota@example.test",
              url: "http://localhost/link",
              kind: "verify",
            }),
          ),
        );
        assert.equal(sent, 1);
        await pool.query(
          "UPDATE auth_email_limits SET count=90 WHERE key='daily'",
        );
        await deliver({
          to: "other@example.test",
          url: "http://localhost/link",
          kind: "reset",
        });
        assert.equal(sent, 1);
      },
    );
  } finally {
    await pool.end();
  }
});
