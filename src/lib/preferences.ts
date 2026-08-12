import type { ReaderPreferences } from "../types/library";
import { DEFAULT_PREFERENCES } from "../types/library";

const THEMES = new Set(["white", "paper", "night", "contrast"]);
const FONT_FAMILIES = new Set(["publisher", "serif", "sans"]);
const CONTENT_WIDTHS = new Set(["narrow", "standard", "wide"]);
const LINE_HEIGHTS = [1.4, 1.65, 1.9] as const;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nearestLineHeight(value: unknown): ReaderPreferences["lineHeight"] {
  const number = finiteNumber(value, DEFAULT_PREFERENCES.lineHeight);
  return LINE_HEIGHTS.reduce((closest, candidate) => (
    Math.abs(candidate - number) < Math.abs(closest - number) ? candidate : closest
  ));
}

export function normalizePreferences(value: unknown): ReaderPreferences {
  const stored = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const legacyScale = finiteNumber(stored.fontScale, 1);
  const fontSize = finiteNumber(stored.fontSizePercent, legacyScale * 100);

  return {
    version: 2,
    theme: THEMES.has(String(stored.theme))
      ? stored.theme as ReaderPreferences["theme"]
      : DEFAULT_PREFERENCES.theme,
    fontSizePercent: Math.round(Math.min(200, Math.max(80, fontSize)) / 10) * 10,
    fontFamily: FONT_FAMILIES.has(String(stored.fontFamily))
      ? stored.fontFamily as ReaderPreferences["fontFamily"]
      : DEFAULT_PREFERENCES.fontFamily,
    lineHeight: nearestLineHeight(stored.lineHeight),
    paragraphIndent: stored.paragraphIndent === 2 ? 2 : 0,
    contentWidth: CONTENT_WIDTHS.has(String(stored.contentWidth))
      ? stored.contentWidth as ReaderPreferences["contentWidth"]
      : DEFAULT_PREFERENCES.contentWidth,
  };
}
