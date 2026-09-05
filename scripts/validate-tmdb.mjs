// Research command: no database writes; output contains only selected movie data.
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { selectTheatricalDates } from "./tmdb-dates.mjs";

const token = process.env.TMDB_READ_ACCESS_TOKEN?.trim();
const currentMonth = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
}).formatToParts(new Date());
const defaultMonth = `${currentMonth.find((p) => p.type === "year").value}-${currentMonth.find((p) => p.type === "month").value}`;
const startMonth = process.argv[2] ?? defaultMonth;
const monthCount = Number(process.argv[3] ?? 7);

async function request(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.search = new URLSearchParams(params).toString();
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt < 2) {
        await delay(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(
        `Network request failed for ${path}; request headers omitted.`,
      );
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new Error(`Invalid JSON response for ${path}.`);
      }
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      if (attempt < 2) {
        await delay(
          Math.min(
            30_000,
            Math.max(1000 * 2 ** attempt, retryAfter * 1000 || 0),
          ),
        );
        continue;
      }
    } else {
      await response.body?.cancel();
    }
    throw new Error(
      `TMDB request returned HTTP ${response.status} for ${path}. For 403, check sandbox network access; for 401, check the read-access token.`,
    );
  }
}

async function batches(values, fn) {
  const results = [];
  for (let i = 0; i < values.length; i += 5) {
    results.push(...(await Promise.all(values.slice(i, i + 5).map(fn))));
  }
  return results;
}

async function main() {
  if (!token)
    throw new Error("Set TMDB_READ_ACCESS_TOKEN in the backend .env file.");
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(startMonth) ||
    Number(startMonth.slice(0, 4)) < 1900 ||
    !Number.isInteger(monthCount) ||
    monthCount < 1 ||
    monthCount > 12
  ) {
    throw new Error(
      "Usage: node --use-env-proxy --env-file=.env scripts/validate-tmdb.mjs [YYYY-MM] [1-12 months]",
    );
  }
  const [year, month] = startMonth.split("-").map(Number);
  const date = (d) => d.toISOString().slice(0, 10);
  const windows = Array.from({ length: monthCount }, (_, i) => ({
    from: date(new Date(Date.UTC(year, month - 1 + i, 1))),
    to: date(new Date(Date.UTC(year, month + i, 0))),
  }));
  const discoveries = [];
  for (const window of windows) {
    const params = {
      region: "GB",
      with_release_type: "3",
      sort_by: "release_date.asc",
      "release_date.gte": window.from,
      "release_date.lte": window.to,
    };
    const first = await request("/discover/movie", { ...params, page: "1" });
    if (
      !Array.isArray(first.results) ||
      !Number.isInteger(first.total_pages) ||
      first.total_pages < 0 ||
      first.total_pages > 500
    ) {
      throw new Error(
        "Unexpected discovery pagination; narrow the query instead of truncating results.",
      );
    }
    const remaining = await batches(
      Array.from(
        { length: Math.max(0, first.total_pages - 1) },
        (_, i) => i + 2,
      ),
      (page) => request("/discover/movie", { ...params, page: String(page) }),
    );
    const movies = [first, ...remaining]
      .flatMap((p) => p.results)
      .map((m) => ({
        id: m.id,
        title: m.title,
        discover_date: m.release_date,
      }));
    discoveries.push({
      ...window,
      query: params,
      reported_results: first.total_results,
      pages: first.total_pages,
      movies,
    });
    console.log(
      `${window.from.slice(0, 7)}: ${movies.length} results across ${first.total_pages} pages`,
    );
  }
  const ids = [
    ...new Set(discoveries.flatMap((w) => w.movies.map((m) => m.id))),
  ];
  const releases = new Map(
    await batches(ids, async (id) => {
      const data = await request(`/movie/${id}/release_dates`);
      const gb = (data.results ?? [])
        .filter((r) => r.iso_3166_1 === "GB")
        .flatMap((r) => r.release_dates)
        .map((r) => ({
          type: r.type,
          date: r.release_date?.slice(0, 10) ?? null,
        }));
      return [id, gb];
    }),
  );
  for (const window of discoveries) {
    for (const movie of window.movies) {
      movie.gb_releases = releases.get(movie.id);
      movie.qualifying_dates = selectTheatricalDates(
        movie.gb_releases,
        window.from,
        window.to,
      );
      movie.discover_date_matches = movie.qualifying_dates.includes(
        movie.discover_date,
      );
    }
    window.duplicate_ids =
      window.movies.length - new Set(window.movies.map((m) => m.id)).size;
    window.date_mismatches = window.movies.filter(
      (m) => !m.discover_date_matches,
    ).length;
    window.missing_qualifying_release = window.movies.filter(
      (m) => m.qualifying_dates.length === 0,
    ).length;
    window.chronological = window.movies.every(
      (m, i, all) => i === 0 || all[i - 1].discover_date <= m.discover_date,
    );
  }
  const report = {
    checked_at: new Date().toISOString(),
    unique_movies: ids.length,
    note: "Live snapshot; checks source consistency, not completeness against an independent UK release calendar.",
    windows: discoveries,
  };
  await mkdir(new URL("../docs/", import.meta.url), { recursive: true });
  const destination = new URL("../docs/tmdb-validation.json", import.meta.url);
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  console.log(
    `Compared ${ids.length} films with explicit GB release records. Saved docs/tmdb-validation.json.`,
  );
  for (const w of discoveries)
    console.log(
      `${w.from.slice(0, 7)}: ${w.date_mismatches} date mismatches; ${w.missing_qualifying_release} missing GB type-3 records; ${w.duplicate_ids} duplicate IDs; chronological=${w.chronological}`,
    );
}

main().catch((error) => {
  // Only our fixed diagnostic errors are displayed; suppress unexpected objects.
  const known =
    /^(Network request|Invalid JSON|TMDB request|Set TMDB|Usage:|Unexpected discovery)/;
  console.error(
    known.test(error?.message ?? "")
      ? error.message
      : "Validation failed unexpectedly; no request headers or credentials logged.",
  );
  process.exitCode = 1;
});
