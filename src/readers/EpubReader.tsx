import { useEffect, useRef } from "react";
import type { ReaderPreferences, ReadingLocator } from "../types/library";
import "foliate-js/view.js";

interface EpubReaderProps {
  file: Blob;
  locator?: ReadingLocator;
  preferences: ReaderPreferences;
  onProgress: (locator: ReadingLocator) => void;
  navigationRef: React.RefObject<{ previous: () => void; next: () => void } | null>;
}

function readerStyles(preferences: ReaderPreferences): string {
  const colors = preferences.theme === "night"
    ? { background: "#171918", text: "#e5e8e2", link: "#9dd0bf" }
    : preferences.theme === "contrast"
      ? { background: "#ffffff", text: "#050505", link: "#005fcc" }
      : { background: "#f5f1e8", text: "#292a27", link: "#176b57" };
  return `
    :root { color-scheme: ${preferences.theme === "night" ? "dark" : "light"}; }
    html { background: ${colors.background}; color: ${colors.text}; font-size: ${preferences.fontScale}em; }
    body { line-height: ${preferences.lineHeight}; padding: 0 0.5rem; }
    p, li, blockquote { line-height: ${preferences.lineHeight}; }
    img, svg { max-width: 100%; max-height: 92vh; object-fit: contain; }
    a { color: ${colors.link}; }
    pre { white-space: pre-wrap; }
  `;
}

export function EpubReader({ file, locator, preferences, onProgress, navigationRef }: EpubReaderProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const initialLocationRef = useRef(locator?.type === "epub" ? locator.value : undefined);
  const preferencesRef = useRef(preferences);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = document.createElement("foliate-view");
    view.className = "foliate-reader";
    host.append(view);
    viewRef.current = view;

    const initialLocation = initialLocationRef.current;
    let active = true;
    let lastWrite = 0;
    const handleRelocate = (event: Event) => {
      const detail = (event as CustomEvent<{ fraction?: number; cfi?: string; tocItem?: { label?: string } }>).detail;
      if (!detail?.cfi) return;
      const now = Date.now();
      if (now - lastWrite < 700) return;
      lastWrite = now;
      onProgress({
        type: "epub",
        value: detail.cfi,
        progression: Math.max(0, Math.min(1, detail.fraction ?? 0)),
        label: detail.tocItem?.label,
      });
    };

    const openBook = async () => {
      await view.open(file);
      if (!active) return;
      view.addEventListener("relocate", handleRelocate);
      view.addEventListener("external-link", (event) => event.preventDefault());
      view.renderer?.setAttribute("flow", "paginated");
      view.renderer?.setAttribute("max-inline-size", "720px");
      view.renderer?.setAttribute("gap", "5%");
      view.renderer?.setStyles?.(readerStyles(preferencesRef.current));
      await view.init({
        lastLocation: initialLocation,
        showTextStart: !initialLocation,
      });
    };

    void openBook().catch((error: unknown) => {
      host.replaceChildren();
      const message = document.createElement("p");
      message.className = "reader-error";
      message.textContent = error instanceof Error ? error.message : "This EPUB could not be opened.";
      host.append(message);
    });

    navigationRef.current = {
      previous: () => void view.goLeft(),
      next: () => void view.goRight(),
    };

    return () => {
      active = false;
      navigationRef.current = null;
      view.removeEventListener("relocate", handleRelocate);
      view.close();
      view.remove();
      viewRef.current = null;
    };
  }, [file, navigationRef, onProgress]);

  useEffect(() => {
    preferencesRef.current = preferences;
    viewRef.current?.renderer?.setStyles?.(readerStyles(preferences));
  }, [preferences]);

  return <div className="reader-stage epub-stage" ref={hostRef} />;
}
