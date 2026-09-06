import type { Pool } from "pg";
import { monthWindows, ukToday } from "./dates.js";

export interface ReleaseMatch {
  filmId: string;
  title: string;
  month: string;
  releaseDate: string;
}
export interface ReleaseMatches {
  query: string;
  month: string;
  matches: ReleaseMatch[];
  hasMore: boolean;
}
export async function searchReleases(
  pool: Pool,
  query: string,
  month: string,
  now = new Date(),
): Promise<ReleaseMatches> {
  const currentMonth = ukToday(now).slice(0, 7);
  const windows = monthWindows(currentMonth);
  // One statement uses one committed snapshot for the supported range and dates.
  // position() treats %, _ and backslashes literally, like the UI title filter.
  const result = await pool.query<ReleaseMatch>(
    `
    WITH bounds AS (
      SELECT least(coalesce(min(window_start), $1::date), $1::date) AS first_date
      FROM upcoming.sync_runs WHERE status='succeeded'
    )
    SELECT f.id AS "filmId", f.title, to_char(r.release_date, 'YYYY-MM') AS month,
      min(r.release_date)::text AS "releaseDate"
    FROM upcoming.films f JOIN upcoming.releases r ON r.film_id=f.id CROSS JOIN bounds b
    WHERE r.country='GB' AND r.release_type=3
      AND r.release_date >= b.first_date AND r.release_date <= $2::date
      AND to_char(r.release_date, 'YYYY-MM') <> $3
      AND position(lower($4) in lower(f.title)) > 0
    GROUP BY f.id, f.title, to_char(r.release_date, 'YYYY-MM')
    ORDER BY min(r.release_date), f.title COLLATE "C", f.id
    LIMIT 21`,
    [windows[0]!.from, windows.at(-1)!.to, month, query],
  );
  return {
    query,
    month,
    matches: result.rows.slice(0, 20),
    hasMore: result.rows.length > 20,
  };
}
