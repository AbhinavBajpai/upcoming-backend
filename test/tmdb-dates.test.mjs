import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectTheatricalDates } from "../scripts/tmdb-dates.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/tmdb-rereleases.json", import.meta.url),
    "utf8",
  ),
);
for (const movie of fixture.movies) {
  test(`real re-release: ${movie.title} uses the matching 2026 date rather than discovery's old date`, () => {
    const dates = selectTheatricalDates(
      movie.gb_releases,
      fixture.from,
      fixture.to,
    );
    assert.deepEqual(dates, movie.qualifying_dates);
    assert.ok(!dates.includes(movie.discover_date));
  });
}
test("synthetic: limited theatrical qualifies; premiere, digital and missing dates do not", () => {
  assert.deepEqual(
    selectTheatricalDates(
      [
        { type: 1, date: "2026-10-02" },
        { type: 2, date: "2026-10-03" },
        { type: 4, date: "2026-10-04" },
        { type: 3, date: null },
        { type: 3, date: "" },
      ],
      fixture.from,
      fixture.to,
    ),
    ["2026-10-03"],
  );
  assert.deepEqual(selectTheatricalDates([], fixture.from, fixture.to), []);
});
test("synthetic: month bounds are inclusive and duplicate dates collapse in chronological order", () => {
  assert.deepEqual(
    selectTheatricalDates(
      [
        { type: 3, date: "2026-11-01" },
        { type: 3, date: "2026-10-31" },
        { type: 2, date: "2026-10-01" },
        { type: 3, date: "2026-09-30" },
        { type: 3, date: "2026-10-01" },
      ],
      fixture.from,
      fixture.to,
    ),
    ["2026-10-01", "2026-10-31"],
  );
});
test("synthetic: a postponed release moves out of the original month", () => {
  const before = [{ type: 3, date: "2026-10-23" }];
  const after = [{ type: 3, date: "2026-11-06" }];
  assert.deepEqual(selectTheatricalDates(before, fixture.from, fixture.to), [
    "2026-10-23",
  ]);
  assert.deepEqual(selectTheatricalDates(after, fixture.from, fixture.to), []);
  assert.deepEqual(selectTheatricalDates(after, "2026-11-01", "2026-11-30"), [
    "2026-11-06",
  ]);
});
