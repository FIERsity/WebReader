import type { ReaderPreferences, ReaderTheme } from "../types/library";

export interface EpubThemeColors {
  background: string;
  text: string;
  link: string;
  surfaceBackground: string;
  surfaceText: string;
  surfaceLink: string;
  codeBackground: string;
  codeText: string;
  codeLink: string;
}

export const EPUB_THEME_COLORS: Record<ReaderTheme, EpubThemeColors> = {
  white: {
    background: "#ffffff",
    text: "#222522",
    link: "#12634f",
    surfaceBackground: "#e5eee9",
    surfaceText: "#17251f",
    surfaceLink: "#12634f",
    codeBackground: "#161b19",
    codeText: "#edf3ef",
    codeLink: "#9dd0bf",
  },
  paper: {
    background: "#f5f1e8",
    text: "#292a27",
    link: "#176b57",
    surfaceBackground: "#e1e8df",
    surfaceText: "#1d2923",
    surfaceLink: "#176b57",
    codeBackground: "#1b1e1c",
    codeText: "#f1f3ef",
    codeLink: "#9dd0bf",
  },
  night: {
    background: "#171918",
    text: "#e5e8e2",
    link: "#9dd0bf",
    surfaceBackground: "#29312d",
    surfaceText: "#edf1ed",
    surfaceLink: "#9dd0bf",
    codeBackground: "#0e1110",
    codeText: "#f2f5f3",
    codeLink: "#9dd0bf",
  },
  contrast: {
    background: "#ffffff",
    text: "#050505",
    link: "#005fcc",
    surfaceBackground: "#000000",
    surfaceText: "#ffffff",
    surfaceLink: "#9ed8ff",
    codeBackground: "#000000",
    codeText: "#ffffff",
    codeLink: "#9ed8ff",
  },
};

const FONT_STACK = {
  serif: 'Georgia, "Songti SC", "Noto Serif CJK SC", serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif',
} as const;

export function buildEpubStyles(preferences: ReaderPreferences): string {
  const colors = EPUB_THEME_COLORS[preferences.theme];
  const font = preferences.fontFamily === "publisher" ? "" : `
    body, p, li, blockquote, dd { font-family: ${FONT_STACK[preferences.fontFamily]} !important; }
  `;
  const indent = `body p:not(li p):not(blockquote p) { text-indent: ${preferences.paragraphIndent}em !important; }`;

  return `
    :root {
      --theme-bg-color: ${colors.background};
      --reader-surface-background: ${colors.surfaceBackground};
      --reader-surface-text: ${colors.surfaceText};
      --reader-surface-link: ${colors.surfaceLink};
      --reader-code-background: ${colors.codeBackground};
      --reader-code-text: ${colors.codeText};
      --reader-code-link: ${colors.codeLink};
      color-scheme: ${preferences.theme === "night" ? "dark" : "light"};
      background-color: ${colors.background} !important;
      color: ${colors.text} !important;
      font-size: ${preferences.fontSizePercent}% !important;
    }
    body { background-color: transparent !important; color: ${colors.text} !important; line-height: ${preferences.lineHeight} !important; padding: 0 0.5rem; }
    body, p, li, blockquote, dd { font-size: 1rem !important; }
    p, li, blockquote, dd { line-height: ${preferences.lineHeight} !important; }
    ${font}
    ${indent}
    img, svg { max-width: 100%; max-height: 92vh; object-fit: contain; }
    a:not(svg a) { color: ${colors.link} !important; }
    blockquote, th {
      background-color: var(--reader-surface-background) !important;
      color: var(--reader-surface-text) !important;
    }
    :where(blockquote, th) :where(*):not(:where(svg, svg *)) {
      color: inherit !important;
    }
    :where(blockquote, th) a:not(svg a) {
      color: var(--reader-surface-link) !important;
    }
    pre, code {
      background-color: var(--reader-code-background) !important;
      color: var(--reader-code-text) !important;
    }
    pre :where(*):not(svg):not(svg *),
    code :where(*):not(svg):not(svg *) { color: inherit !important; }
    pre a:not(svg a), code a:not(svg a) { color: var(--reader-code-link) !important; }
    pre { white-space: pre-wrap; }
    pre code { background-color: transparent !important; color: inherit !important; }
  `;
}
