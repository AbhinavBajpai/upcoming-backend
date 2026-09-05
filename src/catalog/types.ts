import type { MonthWindow } from "./dates.js";
export interface Release {
  country: string;
  type: number;
  date: string | null;
}
export interface FilmSnapshot {
  tmdbId: number;
  title: string;
  posterPath: string | null;
  imdbId: string | null;
  releases: Release[];
}
export interface FilmSource {
  discover(windows: MonthWindow[]): Promise<number[]>;
  film(tmdbId: number): Promise<FilmSnapshot>;
}
export class SourceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
