export type BookFormat = "epub" | "pdf" | "txt";

export type ReaderTheme = "paper" | "night" | "contrast";

export interface ReadingLocator {
  type: "epub" | "pdf" | "text";
  value: string;
  progression: number;
  label?: string;
}

export interface BookRecord {
  id: string;
  fingerprint: string;
  title: string;
  author?: string;
  format: BookFormat;
  fileName: string;
  mediaType: string;
  size: number;
  addedAt: number;
  updatedAt: number;
  locator?: ReadingLocator;
}

export interface ReaderPreferences {
  theme: ReaderTheme;
  fontScale: number;
  lineHeight: number;
}

export const DEFAULT_PREFERENCES: ReaderPreferences = {
  theme: "paper",
  fontScale: 1,
  lineHeight: 1.65,
};
