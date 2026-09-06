import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";

test("public release search trims input and validates query shape and month", async () => {
  let calls = 0;
  const app = createApp({
    checkDatabase: async () => {},
    clock: () => new Date("2026-08-31T23:30:00Z"),
    findReleases: async (query, month) => {
      calls++;
      assert.equal(query, "Devils");
      assert.equal(month, "2026-09");
      return { query, month, matches: [], hasMore: false };
    },
  });
  await request(app)
    .get("/api/releases/search")
    .query({ q: "  Devils  " })
    .expect(200)
    .expect("Cache-Control", "no-store");
  for (const query of [
    "",
    "q=",
    "q=%20",
    `q=${"x".repeat(201)}`,
    "q=a&q=b",
    "q=a&month=2026-13",
    "q=a&month=2026-09&month=2026-10",
    "q=a&owner=b",
  ]) {
    await request(app).get(`/api/releases/search?${query}`).expect(400);
  }
  assert.equal(calls, 1);
});
test("search failures do not expose database details", async () => {
  const app = createApp({
    checkDatabase: async () => {},
    findReleases: async () => {
      throw new Error("secret database details");
    },
  });
  const response = await request(app)
    .get("/api/releases/search?q=Devils")
    .expect(503);
  assert.equal(response.body.error.code, "SEARCH_UNAVAILABLE");
  assert.ok(!JSON.stringify(response.body).includes("secret"));
});
