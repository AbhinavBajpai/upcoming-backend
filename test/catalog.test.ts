import test from "node:test";
import assert from "node:assert/strict";
import { monthWindows, ukToday } from "../src/catalog/dates.js";
import { TmdbSource, inBatches } from "../src/catalog/tmdb.js";
const noWait = async () => {};
const page = (ids: number[], current = 1, pages = 1, total = ids.length) => ({
  page: current,
  total_pages: pages,
  total_results: total,
  results: ids.map((id) => ({ id })),
});
const response = (data: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });

test("calendar windows span full months across leap day and year-end; today uses UK time", () => {
  assert.deepEqual(monthWindows("2028-02", 1), [
    { from: "2028-02-01", to: "2028-02-29" },
  ]);
  assert.deepEqual(monthWindows("2026-12", 2).at(-1), {
    from: "2027-01-01",
    to: "2027-01-31",
  });
  assert.equal(ukToday(new Date("2026-09-30T23:30:00Z")), "2026-10-01");
  assert.throws(() => monthWindows("2026-13"), /INVALID/);
});
test("discovery paginates using GB theatrical filters and deduplicates IDs", async () => {
  const requested: URL[] = [];
  const transport: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    const n = Number(url.searchParams.get("page"));
    return response(n === 1 ? page([1, 2], 1, 2, 3) : page([2], 2, 2, 3));
  };
  assert.deepEqual(
    await new TmdbSource("test-token", transport, noWait).discover(
      monthWindows("2026-10", 1),
    ),
    [1, 2],
  );
  assert.equal(requested.length, 2);
  for (const url of requested) {
    assert.equal(url.searchParams.get("region"), "GB");
    assert.equal(url.searchParams.get("with_release_type"), "3");
    assert.equal(url.searchParams.get("release_date.lte"), "2026-10-31");
  }
});
test("explicit regional dates retain revivals and ignore the film headline date", async () => {
  const source = new TmdbSource(
    "test-token",
    async () =>
      response({
        id: 31767,
        title: "The Devils",
        poster_path: null,
        release_date: "1971-07-25",
        release_dates: {
          results: [
            {
              iso_3166_1: "US",
              release_dates: [
                { type: 3, release_date: "2026-10-01T00:00:00.000Z" },
              ],
            },
            {
              iso_3166_1: "GB",
              release_dates: [
                { type: 3, release_date: "1971-07-25T00:00:00.000Z" },
                { type: 3, release_date: "2026-10-30T00:00:00.000Z" },
                { type: 3, release_date: "2026-10-30T00:00:00.000Z" },
                { type: 4, release_date: null },
              ],
            },
          ],
        },
      }),
    noWait,
  );
  const film = await source.film(31767);
  assert.deepEqual(film.releases, [
    { country: "GB", type: 3, date: "1971-07-25" },
    { country: "GB", type: 3, date: "2026-10-30" },
    { country: "GB", type: 4, date: null },
  ]);
});
test("malformed regional responses fail rather than erase stored dates", async () => {
  const source = new TmdbSource(
    "test-token",
    async () => response({ id: 1, title: "Film", poster_path: null }),
    noWait,
  );
  await assert.rejects(source.film(1), /TMDB_INVALID_MOVIE/);
});
test("rate limits retry with bounded attempts and respect a numeric Retry-After", async () => {
  const waits: number[] = [];
  let calls = 0;
  const source = new TmdbSource(
    "test-token",
    async () => {
      calls++;
      return calls === 1
        ? response({}, 429, { "retry-after": "3" })
        : response(page([]));
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.deepEqual(await source.discover(monthWindows("2026-10", 1)), []);
  assert.equal(calls, 2);
  assert.ok(waits.includes(3000));
});
test("authentication failures are not retried and upstream errors never expose secrets", async () => {
  let calls = 0;
  const source = new TmdbSource(
    "secret-test-token",
    async () => {
      calls++;
      return response({ token: "secret-test-token" }, 401);
    },
    noWait,
  );
  await assert.rejects(source.discover(monthWindows("2026-10", 1)), {
    message: "TMDB_HTTP_401",
  });
  assert.equal(calls, 1);
});
test("network errors retry three times, then return only a safe code", async () => {
  let calls = 0;
  const source = new TmdbSource(
    "secret-test-token",
    async () => {
      calls++;
      throw new Error("secret-test-token");
    },
    noWait,
  );
  await assert.rejects(source.discover(monthWindows("2026-10", 1)), {
    message: "TMDB_NETWORK_ERROR",
  });
  assert.equal(calls, 3);
});
test("changed pagination fails instead of treating a partial list as complete", async () => {
  const source = new TmdbSource(
    "test-token",
    async (input) => {
      const n = Number(new URL(String(input)).searchParams.get("page"));
      return response(n === 1 ? page([1], 1, 2, 2) : page([], 2, 2, 2));
    },
    noWait,
  );
  await assert.rejects(
    source.discover(monthWindows("2026-10", 1)),
    /TMDB_DISCOVERY_CHANGED/,
  );
});
test("batches limit concurrency and drain in-flight work before rejecting", async () => {
  let active = 0;
  let max = 0;
  let completed = 0;
  await assert.rejects(
    inBatches([1, 2, 3, 4, 5, 6], async (value) => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active--;
      completed++;
      if (value === 1) throw new Error("failed");
      return value;
    }),
  );
  assert.equal(max, 5);
  assert.equal(active, 0);
  assert.equal(completed, 5);
});
