import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";

const healthy = async () => {};
test("liveness is independent of database availability; readiness fails without leaking errors", async () => {
  const app = createApp({
    checkDatabase: async () => {
      throw new Error("postgres://secret");
    },
  });
  await request(app)
    .get("/api/health")
    .expect(200)
    .expect("Cache-Control", "no-store");
  const response = await request(app).get("/api/ready").expect(503);
  assert.deepEqual(response.body, {
    status: "unavailable",
    database: "unavailable",
  });
});
test("readiness succeeds when its database check succeeds", async () => {
  await request(createApp({ checkDatabase: healthy }))
    .get("/api/ready")
    .expect(200);
});
test("SPA deep links work while unknown API routes and missing assets remain 404", async () => {
  const dir = await mkdtemp(join(tmpdir(), "upcoming-web-"));
  try {
    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><title>Upcoming</title>",
    );
    const app = createApp({ checkDatabase: healthy, frontendDir: dir });
    for (const path of ["/", "/releases", "/starred", "/friends"]) {
      await request(app).get(path).expect(200).expect("Content-Type", /html/);
    }
    await request(app)
      .get("/api/unknown")
      .expect(404)
      .expect("Content-Type", /json/);
    await request(app).post("/api/unknown").expect(404);
    await request(app).get("/assets/missing.js").expect(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("malformed JSON produces a controlled client error", async () => {
  await request(createApp({ checkDatabase: healthy }))
    .post("/api/unknown")
    .set("Content-Type", "application/json")
    .send("{")
    .expect(400);
});
test("production requires explicit database configuration and valid port", () => {
  assert.throws(() => readConfig({ NODE_ENV: "production" }), /DATABASE_URL/);
  assert.throws(() => readConfig({ PORT: "0" }), /PORT/);
});
