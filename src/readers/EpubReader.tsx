import { useEffect, useRef } from "react";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import type { ReaderPreferences, ReadingLocator } from "../types/library";
import type { ReaderCapabilities, ReaderController, ReaderOutlineItem } from "../types/reader";
import "foliate-js/view.js";

interface EpubReaderProps {
  file: Blob;
  locator?: ReadingLocator;
  preferences: ReaderPreferences;
  onProgress: (locator: ReadingLocator) => void;
  onOutline: (items: ReaderOutlineItem[], automatic?: boolean) => void;
  onCapabilities: (capabilities: ReaderCapabilities) => void;
  onCurrentTarget: (target?: string) => void;
  onLocationLabel: (label?: string) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  navigationRef: React.RefObject<ReaderController | null>;
  t: (key: TranslationKey, variables?: TranslationVariables) => string;
}

const CONTENT_WIDTH = { narrow: "600px", standard: "720px", wide: "880px" } as const;
const FONT_STACK = {
  serif: 'Georgia, "Songti SC", "Noto Serif CJK SC", serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif',
} as const;

function readerStyles(preferences: ReaderPreferences): string {
  const colors = preferences.theme === "night"
    ? { background: "#171918", text: "#e5e8e2", link: "#9dd0bf" }
    : preferences.theme === "contrast"
      ? { background: "#ffffff", text: "#050505", link: "#005fcc" }
      : preferences.theme === "white"
        ? { background: "#ffffff", text: "#222522", link: "#12634f" }
        : { background: "#f5f1e8", text: "#292a27", link: "#176b57" };
  const font = preferences.fontFamily === "publisher" ? "" : `
    body, p, li, blockquote, dd { font-family: ${FONT_STACK[preferences.fontFamily]} !important; }
  `;
  const indent = `body p:not(li p):not(blockquote p) { text-indent: ${preferences.paragraphIndent}em !important; }`;
  return `
    :root {
      --theme-bg-color: ${colors.background};
      color-scheme: ${preferences.theme === "night" ? "dark" : "light"};
      background: ${colors.background} !important;
      color: ${colors.text} !important;
      font-size: ${preferences.fontSizePercent}% !important;
    }
    html { background-image: none !important; }
    body { background: transparent !important; color: ${colors.text} !important; line-height: ${preferences.lineHeight} !important; padding: 0 0.5rem; }
    body, p, li, blockquote, dd { font-size: 1rem !important; }
    p, li, blockquote, dd { line-height: ${preferences.lineHeight} !important; }
    ${font}
    ${indent}
    img, svg { max-width: 100%; max-height: 92vh; object-fit: contain; }
    a { color: ${colors.link} !important; }
    pre { white-space: pre-wrap; }
  `;
}

function normalizeOutline(items: FoliateTocItem[] | undefined, path = "epub"): ReaderOutlineItem[] {
  return (items ?? []).map((item, index) => ({
    id: `${path}-${index}`,
    label: item.label?.trim() || "…",
    target: item.href ?? undefined,
    children: normalizeOutline(item.subitems ?? undefined, `${path}-${index}`),
  }));
}

export function EpubReader({
  file, locator, preferences, onProgress, onOutline, onCapabilities, onCurrentTarget,
  onLocationLabel, onKeyDown, navigationRef, t,
}: EpubReaderProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const currentCfiRef = useRef(locator?.type === "epub" ? locator.value : undefined);
  const pendingLocatorRef = useRef<ReadingLocator | undefined>(undefined);
  const preferencesRef = useRef(preferences);
  const tRef = useRef(t);

  useEffect(() => { tRef.current = t; }, [t]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = document.createElement("foliate-view");
    view.className = "foliate-reader";
    host.append(view);
    viewRef.current = view;

    const initialLocation = currentCfiRef.current;
    const loadedDocuments = new WeakSet<Document>();
    let active = true;
    let lastWrite = 0;
    const handleRelocate = (event: Event) => {
      const detail = (event as CustomEvent<{ fraction?: number; cfi?: string; tocItem?: { label?: string; href?: string } }>).detail;
      if (!detail?.cfi) return;
      currentCfiRef.current = detail.cfi;
      onCurrentTarget(detail.tocItem?.href);
      onLocationLabel(detail.tocItem?.label);
      const next: ReadingLocator = {
        type: "epub",
        value: detail.cfi,
        progression: Math.max(0, Math.min(1, detail.fraction ?? 0)),
        label: detail.tocItem?.label,
      };
      pendingLocatorRef.current = next;
      const now = Date.now();
      if (now - lastWrite < 700) return;
      lastWrite = now;
      onProgress(next);
    };
    const handleExternalLink = (event: Event) => event.preventDefault();
    const handleLoad = (event: Event) => {
      const doc = (event as CustomEvent<{ doc?: Document }>).detail?.doc;
      if (!doc || loadedDocuments.has(doc)) return;
      loadedDocuments.add(doc);
      doc.addEventListener("keydown", onKeyDown);
    };

    const openBook = async () => {
      await view.open(file);
      if (!active) {
        view.close();
        view.book?.destroy?.();
        return;
      }
      const fixedLayout = view.book?.rendition?.layout === "pre-paginated";
      onCapabilities({ typography: !fixedLayout, outline: Boolean(view.book?.toc?.length), publisherFont: !fixedLayout });
      onOutline(normalizeOutline(view.book?.toc));
      view.addEventListener("load", handleLoad);
      view.addEventListener("relocate", handleRelocate);
      view.addEventListener("external-link", handleExternalLink);
      view.renderer?.setAttribute("flow", "paginated");
      view.renderer?.setAttribute("max-inline-size", CONTENT_WIDTH[preferencesRef.current.contentWidth]);
      view.renderer?.setAttribute("gap", "5%");
      if (!fixedLayout) view.renderer?.setStyles?.(readerStyles(preferencesRef.current));
      await view.init({ lastLocation: initialLocation, showTextStart: !initialLocation });
    };

    void openBook().catch(() => {
      host.replaceChildren();
      const message = document.createElement("p");
      message.className = "reader-error";
      message.textContent = tRef.current("epubOpenFailed");
      host.append(message);
    });

    navigationRef.current = {
      previous: () => void view.prev(),
      next: () => void view.next(),
      goTo: (target) => void view.goTo(target),
    };

    return () => {
      active = false;
      navigationRef.current = null;
      if (pendingLocatorRef.current) onProgress(pendingLocatorRef.current);
      for (const { doc } of view.renderer?.getContents?.() ?? []) doc.removeEventListener("keydown", onKeyDown);
      view.removeEventListener("load", handleLoad);
      view.removeEventListener("relocate", handleRelocate);
      view.removeEventListener("external-link", handleExternalLink);
      view.close();
      view.book?.destroy?.();
      view.remove();
      viewRef.current = null;
      onOutline([]);
      onCapabilities({ typography: false, outline: false, publisherFont: false });
    };
  }, [file, navigationRef, onCapabilities, onCurrentTarget, onKeyDown, onLocationLabel, onOutline, onProgress]);

  useEffect(() => {
    preferencesRef.current = preferences;
    const view = viewRef.current;
    if (!view || view.book?.rendition?.layout === "pre-paginated") return;
    view.renderer?.setAttribute("max-inline-size", CONTENT_WIDTH[preferences.contentWidth]);
    view.renderer?.setStyles?.(readerStyles(preferences));
    const cfi = currentCfiRef.current;
    if (cfi) window.setTimeout(() => void view.goTo(cfi), 0);
  }, [preferences]);

  return <div className="reader-stage epub-stage" ref={hostRef} />;
}
