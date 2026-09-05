import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { isCalendarDate, type MonthWindow } from "./dates.js";
import { SourceError, type FilmSnapshot, type FilmSource } from "./types.js";

const movieId = z.number().int().positive();
const pageSchema = z.object({
  page: z.number().int().positive(),
  total_pages: z.number().int().min(0).max(500),
  total_results: z.number().int().nonnegative(),
  results: z.array(z.object({ id: movieId })),
});
const dateSchema = z
  .string()
  .refine((value) => value === "" || isCalendarDate(value.slice(0, 10)))
  .nullable()
  .transform((value) => (value ? value.slice(0, 10) : null));
const movieSchema = z.object({
  id: movieId,
  title: z.string().trim().min(1),
  poster_path: z.string().nullable(),
  release_dates: z.object({
    results: z.array(
      z.object({
        iso_3166_1: z.string().regex(/^[A-Z]{2}$/),
        release_dates: z.array(
          z.object({
            type: z.number().int().min(1).max(6),
            release_date: dateSchema,
          }),
        ),
      }),
    ),
  }),
});

// Await every started operation before releasing a sync lock or reporting failure.
export async function inBatches<T, R>(
  values: T[],
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];
  for (let i = 0; i < values.length; i += 5) {
    const batch = await Promise.allSettled(values.slice(i, i + 5).map(fn));
    for (const entry of batch) {
      if (entry.status === "rejected") throw entry.reason;
      result.push(entry.value);
    }
  }
  return result;
}

export class TmdbSource implements FilmSource {
  constructor(
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = delay,
  ) {
    if (!token.trim()) throw new SourceError("TMDB_TOKEN_MISSING");
  }
  private async request(
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    url.search = new URLSearchParams(query).toString();
    for (let attempt = 0; attempt < 3; attempt++) {
      // Cap request starts per worker as well as concurrency; stay well below TMDB's upper limit.
      await this.sleep(250);
      let response: Response;
      try {
        response = await this.transport(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        if (attempt < 2) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new SourceError("TMDB_NETWORK_ERROR");
      }
      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new SourceError("TMDB_INVALID_JSON");
        }
      }
      const seconds = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await this.sleep(
          Math.min(
            60_000,
            Math.max(
              1000 * 2 ** attempt,
              Number.isFinite(seconds) ? seconds * 1000 : 0,
            ),
          ),
        );
        continue;
      }
      throw new SourceError(`TMDB_HTTP_${response.status}`);
    }
    throw new SourceError("TMDB_RETRIES_EXHAUSTED");
  }
  async discover(windows: MonthWindow[]): Promise<number[]> {
    const ids = new Set<number>();
    for (const window of windows) {
      const query = {
        region: "GB",
        with_release_type: "3",
        sort_by: "release_date.asc",
        "release_date.gte": window.from,
        "release_date.lte": window.to,
      };
      const getPage = async (page: number) => {
        const parsed = pageSchema.safeParse(
          await this.request("/discover/movie", {
            ...query,
            page: String(page),
          }),
        );
        if (!parsed.success || parsed.data.page !== page)
          throw new SourceError("TMDB_INVALID_DISCOVERY");
        return parsed.data;
      };
      const first = await getPage(1);
      const rest = await inBatches(
        Array.from(
          { length: Math.max(0, first.total_pages - 1) },
          (_, i) => i + 2,
        ),
        getPage,
      );
      const pages = [first, ...rest];
      if (
        pages.some(
          (p) =>
            p.total_pages !== first.total_pages ||
            p.total_results !== first.total_results,
        ) ||
        pages.reduce((n, p) => n + p.results.length, 0) !== first.total_results
      ) {
        throw new SourceError("TMDB_DISCOVERY_CHANGED_DURING_PAGINATION");
      }
      for (const page of pages)
        for (const movie of page.results) ids.add(movie.id);
    }
    return [...ids];
  }
  async film(tmdbId: number): Promise<FilmSnapshot> {
    const parsed = movieSchema.safeParse(
      await this.request(`/movie/${tmdbId}`, {
        append_to_response: "release_dates",
        language: "en-GB",
      }),
    );
    if (!parsed.success || parsed.data.id !== tmdbId)
      throw new SourceError("TMDB_INVALID_MOVIE");
    const movie = parsed.data;
    const releases = movie.release_dates.results
      .filter((r) => r.iso_3166_1 === "GB")
      .flatMap((r) =>
        r.release_dates.map((d) => ({
          country: "GB",
          type: d.type,
          date: d.release_date,
        })),
      );
    const unique = new Map(
      releases.map((r) => [`${r.country}/${r.type}/${r.date}`, r]),
    );
    return {
      tmdbId: movie.id,
      title: movie.title,
      posterPath: movie.poster_path,
      releases: [...unique.values()],
    };
  }
}
