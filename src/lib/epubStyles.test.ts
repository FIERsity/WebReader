import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, type ReaderTheme } from "../types/library";
import { buildEpubStyles, EPUB_THEME_COLORS } from "./epubStyles";

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

const THEMES: ReaderTheme[] = ["white", "paper", "night", "contrast"];

describe("EPUB reader styles", () => {
  it.each(THEMES)("keeps %s theme text surfaces readable", (theme) => {
    const colors = EPUB_THEME_COLORS[theme];

    expect(contrastRatio(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.link, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.surfaceText, colors.surfaceBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.surfaceLink, colors.surfaceBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.codeText, colors.codeBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.codeLink, colors.codeBackground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)("uses explicit paired colors for %s regardless of system preference", (theme) => {
    const styles = buildEpubStyles({ ...DEFAULT_PREFERENCES, theme });
    const colors = EPUB_THEME_COLORS[theme];

    expect(styles).toContain(`--reader-surface-background: ${colors.surfaceBackground}`);
    expect(styles).toContain(`--reader-surface-text: ${colors.surfaceText}`);
    expect(styles).toContain(`--reader-surface-link: ${colors.surfaceLink}`);
    expect(styles).toContain(`--reader-code-link: ${colors.codeLink}`);
    expect(styles).toContain("blockquote, th {");
    expect(styles).toContain(":where(blockquote, th) :where(*):not(:where(svg, svg *)) {");
    expect(styles).toContain(":where(blockquote, th) a:not(svg a) {");
    expect(styles).toContain("pre, code {");
    expect(styles).toContain("pre :where(*):not(svg):not(svg *),");
    expect(styles).toContain("code :where(*):not(svg):not(svg *) {");
    expect(styles).toContain("a:not(svg a)");
    expect(styles).not.toContain("prefers-color-scheme");
  });

  it("preserves publication background images", () => {
    const styles = buildEpubStyles(DEFAULT_PREFERENCES);

    expect(styles).not.toMatch(/background-image\s*:/);
    expect(styles).not.toMatch(/(?:^|[;{])\s*background\s*:/m);
    expect(styles).toContain("background-color:");
  });

  it("leaves image and SVG colors untouched", () => {
    const styles = buildEpubStyles(DEFAULT_PREFERENCES);
    const mediaRule = styles.match(/img, svg \{([^}]*)\}/)?.[1];

    expect(mediaRule).toBeDefined();
    expect(mediaRule).not.toMatch(/(?:background|color|filter)\s*:/);
    expect(styles).not.toContain("figure {");
  });
});
