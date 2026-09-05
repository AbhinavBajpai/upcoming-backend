import type { Pool } from "pg";
import { monthWindows, ukToday } from "./dates.js";

export interface CalendarFilm {
  id: string;
  tmdbId: number;
  title: string;
  posterPath: string | null;
  releaseDate: string;
  isRevival: boolean;
}
export interface ReleaseCalendar {
  month: string;
  today: string;
  currentMonth: string;
  country: "GB";
  range: { from: string; to: string };
  lastSuccessfulSync: string | null;
  monthSynced: boolean;
  films: CalendarFilm[];
}
export class CalendarError extends Error {
  constructor(public readonly code: "INVALID_MONTH" | "MONTH_OUT_OF_RANGE") {
    super(code);
  }
}
export function parseMonth(value: unknown, today: string): string {
  if (value === undefined) return today.slice(0, 7);
  if (
    typeof value !== "string" ||
    !/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/.test(value)
  ) {
    throw new CalendarError("INVALID_MONTH");
  }
  return value;
}

export async function readCalendar(
  pool: Pool,
  month: string,
  now = new Date(),
): Promise<ReleaseCalendar> {
  const today = ukToday(now);
  parseMonth(month, today);
  const currentMonth = today.slice(0, 7);
  const defaultRange = monthWindows(currentMonth);
  const requested = monthWindows(month, 1)[0]!;
  const client = await pool.connect();
  try {
    // Metadata and events must describe the same committed catalogue snapshot.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const metadata = await client.query<{
      first_month: string | null;
      last_success: Date | null;
      month_synced: boolean;
    }>(
      `SELECT to_char(min(window_start), 'YYYY-MM') AS first_month,
        max(completed_at) AS last_success,
        coalesce(bool_or(window_start <= $1::date AND window_end >= $2::date), false) AS month_synced
      FROM upcoming.sync_runs WHERE status = 'succeeded'`,
      [requested.from, requested.to],
    );
    const meta = metadata.rows[0]!;
    const range = {
      from:
        meta.first_month && meta.first_month < currentMonth
          ? meta.first_month
          : currentMonth,
      to: defaultRange.at(-1)!.from.slice(0, 7),
    };
    if (month < range.from || month > range.to)
      throw new CalendarError("MONTH_OUT_OF_RANGE");
    const result = await client.query<CalendarFilm>(
      `
      WITH selected AS (
        SELECT film_id, min(release_date) AS release_date
        FROM upcoming.releases
        WHERE country='GB' AND release_type=3
          AND release_date >= $1::date AND release_date <= $2::date
        GROUP BY film_id
      )
      SELECT f.id, f.tmdb_id AS "tmdbId", f.title, f.poster_path AS "posterPath",
        s.release_date::text AS "releaseDate",
        EXISTS (SELECT 1 FROM upcoming.releases earlier
          WHERE earlier.film_id=f.id AND earlier.country='GB' AND earlier.release_type=3
            AND earlier.release_date < $1::date) AS "isRevival"
      FROM selected s JOIN upcoming.films f ON f.id=s.film_id
      ORDER BY s.release_date, f.title COLLATE "C", f.id`,
      [requested.from, requested.to],
    );
    await client.query("COMMIT");
    return {
      month,
      today,
      currentMonth,
      country: "GB",
      range,
      lastSuccessfulSync: meta.last_success?.toISOString() ?? null,
      monthSynced: meta.month_synced,
      films: result.rows,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
