import type { Pool } from "pg";
import type { CalendarFilm } from "../catalog/calendar.js";
import { ukToday } from "../catalog/dates.js";
export interface StarredFilm extends Omit<CalendarFilm, "releaseDate"> {
  releaseDate: string | null;
  section: "upcoming" | "released" | "tbc";
}
export interface StarredList {
  today: string;
  films: StarredFilm[];
}
export interface StarStore {
  list: (userId: string, now: Date) => Promise<StarredList>;
  set: (userId: string, filmId: string, starred: boolean) => Promise<boolean>;
}
export function starStore(pool: Pool): StarStore {
  return {
    async list(userId, now) {
      const today = ukToday(now);
      const result = await pool.query<StarredFilm>(
        `
        WITH chosen AS (
          SELECT f.id, f.tmdb_id AS "tmdbId", f.title, f.poster_path AS "posterPath", f.imdb_id AS "imdbId",
            coalesce(min(r.release_date) FILTER (WHERE r.release_date >= $2::date),
                     max(r.release_date) FILTER (WHERE r.release_date < $2::date)) AS release_date
          FROM upcoming.stars s JOIN upcoming.films f ON f.id=s.film_id
          LEFT JOIN upcoming.releases r ON r.film_id=f.id AND r.country='GB' AND r.release_type=3
          WHERE s.user_id=$1 GROUP BY f.id
        )
        SELECT id, "tmdbId", title, "posterPath", "imdbId", release_date::text AS "releaseDate",
          CASE WHEN release_date IS NULL THEN 'tbc' WHEN release_date >= $2::date THEN 'upcoming' ELSE 'released' END AS section,
          EXISTS (SELECT 1 FROM upcoming.releases r WHERE r.film_id=chosen.id AND r.country='GB' AND r.release_type=3 AND r.release_date < chosen.release_date) AS "isRevival"
        FROM chosen ORDER BY
          CASE WHEN release_date >= $2::date THEN 0 WHEN release_date IS NOT NULL THEN 1 ELSE 2 END,
          CASE WHEN release_date >= $2::date THEN release_date END ASC,
          CASE WHEN release_date < $2::date THEN release_date END DESC,
          title COLLATE "C", id`,
        [userId, today],
      );
      return { today, films: result.rows };
    },
    async set(userId, filmId, starred) {
      if (starred) {
        const result = await pool.query(
          `INSERT INTO upcoming.stars(user_id,film_id)
          SELECT $1,id FROM upcoming.films WHERE id=$2
          ON CONFLICT(user_id,film_id) DO UPDATE SET film_id=EXCLUDED.film_id RETURNING film_id`,
          [userId, filmId],
        );
        return !!result.rowCount;
      }
      await pool.query(
        "DELETE FROM upcoming.stars WHERE user_id=$1 AND film_id=$2",
        [userId, filmId],
      );
      return true;
    },
  };
}
