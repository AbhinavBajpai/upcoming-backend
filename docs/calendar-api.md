# Monthly release calendar

`GET /api/releases?month=2026-10` is public and reads PostgreSQL only. Omitting `month` selects the current month in Europe/London. The browser never calls TMDB discovery or receives its token.

The response contains `month`, UK calendar `today`, `currentMonth`, `country: "GB"`, inclusive month bounds `range: {from, to}`, `lastSuccessfulSync` (global latest successful import timestamp or null), `monthSynced`, and `films`.

Each film has its stable database `id`, numeric `tmdbId`, `title`, nullable `posterPath`, nullable `imdbId`, date-only `releaseDate`, and `isRevival`. Only dated GB type-2/3 releases within the full requested month qualify. A film appears once, at its earliest qualifying date that month. Ordering is date, title (C collation), then ID. `isRevival` indicates a stored GB theatrical date before this month; it is inferred from source dates, not a curated classification. An original 1971 date does not hide a 2026 revival.

The range starts with the earlier of the current month and the first successful import window; it ends six months after the current month. Original historical release dates do not extend navigation decades into the past. Imported history remains browsable. `monthSynced` means a successful import covered the entire requested month. False is distinct from a successfully imported empty month; it does not imply that every source date is complete or current.

A read-only repeatable-read transaction keeps metadata and films from the same committed snapshot. Responses use `Cache-Control: no-store`. Malformed/repeated month values return 400 `INVALID_MONTH`; unsupported months return 400 `MONTH_OUT_OF_RANGE`. Database failures return 503 `CATALOGUE_UNAVAILABLE`, without raw database errors. Errors have shape `{error: {code, message}}`.

API tests cover validation, UK month boundaries and safe errors. PostgreSQL integration fixtures cover month endpoints, exclusions, duplicates, deterministic ordering, revivals, imported history and empty/unrefreshed months.

IMDb IDs are refreshed by the existing sync job. After upgrading, run an import to populate IDs on existing films. Missing or malformed upstream IDs are stored as null.
