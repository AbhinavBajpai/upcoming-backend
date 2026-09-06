/** Select date-only GB theatrical records already extracted from TMDB. */
export function selectTheatricalDates(records, from, to) {
  return [
    ...new Set(
      records
        .filter(
          (r) =>
            (r.type === 2 || r.type === 3) &&
            typeof r.date === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
            r.date >= from &&
            r.date <= to,
        )
        .map((r) => r.date),
    ),
  ].sort();
}
