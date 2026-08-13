export type BookFormat = "epub" | "pdf" | "txt";
export type ReadingProfile = "book" | "article";

export type ReaderTheme = "white" | "paper" | "night" | "contrast";
export type ReaderFontFamily = "publisher" | "serif" | "sans";
export type ReaderContentWidth = "narrow" | "standard" | "wide";

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
  readingProfile: ReadingProfile;
  fileName: string;
  mediaType: string;
  size: number;
  addedAt: number;
  updatedAt: number;
  locator?: ReadingLocator;
}

export interface ReaderPreferences {
  version: 2;
  theme: ReaderTheme;
  fontSizePercent: number;
  fontFamily: ReaderFontFamily;
  lineHeight: 1.4 | 1.65 | 1.9;
  paragraphIndent: 0 | 2;
  contentWidth: ReaderContentWidth;
}

export const DEFAULT_PREFERENCES: ReaderPreferences = {
  version: 2,
  theme: "paper",
  fontSizePercent: 100,
  fontFamily: "publisher",
  lineHeight: 1.65,
  paragraphIndent: 0,
  contentWidth: "standard",
};
