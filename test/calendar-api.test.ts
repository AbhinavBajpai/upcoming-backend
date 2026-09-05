import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  CalendarError,
  type ReleaseCalendar,
} from "../src/catalog/calendar.js";
const now = new Date("2026-09-30T23:30:00Z");
const payload: ReleaseCalendar = {
  month: "2026-10",
  today: "2026-10-01",
  currentMonth: "2026-10",
  country: "GB",
  range: { from: "2026-09", to: "2027-04" },
  lastSuccessfulSync: null,
  monthSynced: false,
  films: [],
};
const options = { checkDatabase: async () => {}, clock: () => now };

test("public monthly calendar defaults to the current UK month and disables caching", async () => {
  const app = createApp({
    ...options,
    getCalendar: async (month, clock) => {
      assert.equal(month, "2026-10");
      assert.equal(clock, now);
      return payload;
    },
  });
  const r = await request(app)
    .get("/api/releases")
    .expect(200)
    .expect("Cache-Control", "no-store");
  assert.deepEqual(r.body, payload);
});
test("invalid and repeated month parameters are rejected before querying", async () => {
  const app = createApp({
    ...options,
    getCalendar: async () => {
      throw new Error("must not query");
    },
  });
  for (const query of [
    "month=2026-13",
    "month=2026-1",
    "month=",
    "month=2026-10&month=2026-11",
  ]) {
    const r = await request(app).get(`/api/releases?${query}`).expect(400);
    assert.equal(r.body.error.code, "INVALID_MONTH");
  }
});
test("out-of-range month is distinct from a database failure", async () => {
  const outside = createApp({
    ...options,
    getCalendar: async () => {
      throw new CalendarError("MONTH_OUT_OF_RANGE");
    },
  });
  assert.equal(
    (await request(outside).get("/api/releases?month=1900-01").expect(400)).body
      .error.code,
    "MONTH_OUT_OF_RANGE",
  );
  const unavailable = createApp({
    ...options,
    getCalendar: async () => {
      throw new Error("postgres://private");
    },
  });
  const r = await request(unavailable).get("/api/releases").expect(503);
  assert.equal(r.body.error.code, "CATALOGUE_UNAVAILABLE");
  assert.ok(!JSON.stringify(r.body).includes("private"));
});
