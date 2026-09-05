# TMDB release-query validation

Checked on 5 September 2026 using the backend read-access token. The token was never written to the report or fixtures.

## Result

The archived discovery query is a suitable source of candidate films, but its returned `release_date` and ordering are insufficient for the calendar when a film has multiple UK theatrical releases. Fetch each candidate's explicit release records and select GB/type-3 dates within the requested month.

| Calendar month | Films | Pages | Discovery-date mismatches |
| --- | ---: | ---: | ---: |
| September 2026 | 49 | 3 | 0 |
| October 2026 | 48 | 3 | 2 |
| November 2026 | 16 | 1 | 0 |
| December 2026 | 13 | 1 | 0 |
| January 2027 | 11 | 1 | 0 |
| February 2027 | 4 | 1 | 0 |
| March 2027 | 4 | 1 | 0 |

All 145 unique films had an explicit qualifying GB theatrical release in their discovery month. There were no duplicate IDs within any month. October's discovery results were not chronological by the returned date.

| Film | TMDB ID | Discovery date | Matching UK theatrical date |
| --- | ---: | --- | --- |
| For Your Suffering | 1725773 | 2020-10-01 | 2026-10-16 |
| The Devils | 31767 | 1971-07-25 | 2026-10-30 |

The owner identifies The Devils as a wide-release revival. Revivals remain in scope: an older original release year must not exclude a current UK theatrical event. The comparison proves a mismatch between response fields, not that the revival record is erroneous.

## Query and interpretation

Use `/discover/movie` with `region=GB`, `with_release_type=3`, `sort_by=release_date.asc`, inclusive `release_date.gte`/`release_date.lte` calendar-month bounds, and every result page. The validation preserves the archived query's other defaults.

Then use `/movie/{id}/release_dates`, select the GB group and type-3 records, and preserve their calendar-date portion without timezone conversion. Build and sort our calendar using those dates. Do not filter on primary release year or silently fall back to a global date when GB dates are missing.

Proposed rules for the importer and read model:

- Retain distinct release events separately from film identity. Stars belong to film identity.
- Include revivals and re-releases when they have matching GB theatrical records.
- Deduplicate identical GB/type/date records. Preserve distinct dates, even for the same film.
- Show a film once per month, using the earliest qualifying event within that month; the film may appear in another month if it has a separate qualifying event there. This is a proposed display default.
- If explicit records no longer include a qualifying date, omit that event from the month. A starred film with no future confirmed date remains available in the personal list, with history/TBC handled by the watchlist rules.
- Refresh known films as well as discovery results. Absence from discovery alone is not evidence that a release was cancelled.
- Use Europe/London to determine today/current month; store release dates as dates, not instants.

The validation window is the current calendar month through the end of the month six months ahead: September 2026–March 2027, seven complete calendar months. Retain imported history. This is the proposed bounded v1 window, not an unlimited calendar commitment.

## Evidence and limits

`tmdb-validation.json` contains a timestamped, selected-field snapshot for all 145 films and their GB release records. `test/fixtures/tmdb-rereleases.json` contains the two observed mismatches. The offline tests also explicitly label synthetic examples for missing/withdrawn dates, mixed release types, month edges, duplicate dates and postponements. No live date-change history was observed in this single snapshot.

This checks TMDB's internal consistency; it does not establish completeness or accuracy against an independent UK distributor calendar. Far-future counts are sparse and should be treated as currently announced source data. No extra popularity threshold or original-language filter has been introduced. The owner has independently identified one revival, but the other release records have not been independently verified.

## Source documentation and attribution

- [Discover movie](https://developer.themoviedb.org/reference/discover-movie): regional and release-type filtering and discovery-date semantics.
- [Region support](https://developer.themoviedb.org/docs/region-support): type 3 is theatrical; limited theatrical is a separate type 2.
- [Movie release dates](https://developer.themoviedb.org/reference/movie-release-dates): explicit regional events.
- [TMDB FAQ](https://developer.themoviedb.org/docs/faq): non-commercial API use is free with attribution. Include an approved TMDB logo, less prominent than the app branding, in About/Credits and prominently display: “This product uses the TMDB API but is not endorsed or certified by TMDB.” Use approved logo assets without suggesting endorsement. Revisit usage terms if the project becomes commercial.
