import { useEffect, useRef } from "react";
import { createEpubDisposer } from "../lib/epubCleanup";
import { buildEpubStyles } from "../lib/epubStyles";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import type { ReaderPreferences, ReadingLocator, ReadingProfile } from "../types/library";
import { WheelGesture, normalizedWheelDelta, shouldIgnoreWheel } from "../lib/wheelPager";
import type { ReaderCapabilities, ReaderController, ReaderOutlineItem } from "../types/reader";
import "foliate-js/view.js";

interface EpubReaderProps {
  readingProfile: ReadingProfile;
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

function normalizeOutline(items: FoliateTocItem[] | undefined, path = "epub"): ReaderOutlineItem[] {
  return (items ?? []).map((item, index) => ({
    id: `${path}-${index}`,
    label: item.label?.trim() || "…",
    target: item.href ?? undefined,
    children: normalizeOutline(item.subitems ?? undefined, `${path}-${index}`),
  }));
}

export function EpubReader({
  readingProfile, file, locator, preferences, onProgress, onOutline, onCapabilities, onCurrentTarget,
  onLocationLabel, onKeyDown, navigationRef, t,
}: EpubReaderProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const currentCfiRef = useRef(locator?.type === "epub" ? locator.value : undefined);
  const pendingLocatorRef = useRef<ReadingLocator | undefined>(undefined);
  const preferencesRef = useRef(preferences);
  const relocationTimerRef = useRef<number | undefined>(undefined);
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
    const loadedDocuments = new Set<Document>();
    const wheelDocuments = new Set<Document>();
    const wheelGesture = new WheelGesture();
    let active = true;
    let initializationFinished = false;
    let disposeRequested = false;
    let lastWrite = 0;
    const handleRelocate = (event: Event) => {
      if (!active) return;
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
    const handleWheel = (event: WheelEvent) => {
      if (shouldIgnoreWheel(event)) return;
      const renderer = view.renderer;
      if (!renderer) return;
      const delta = normalizedWheelDelta(event, renderer.clientHeight || window.innerHeight);
      if (!delta) return;

      if (readingProfile === "article" && renderer.scrolled) {
        const atStart = renderer.start <= 1;
        const atEnd = renderer.viewSize - renderer.end <= 2;
        const eligible = (delta < 0 && atStart) || (delta > 0 && atEnd);
        const direction = wheelGesture.push(delta, event.timeStamp, eligible);
        if (!eligible || !direction) return;
        event.preventDefault();
        void (direction === "previous" ? view.prev() : view.next());
        return;
      }

      event.preventDefault();
      const direction = wheelGesture.push(delta, event.timeStamp);
      if (direction === "previous") void view.prev();
      else if (direction === "next") void view.next();
    };
    const handleLoad = (event: Event) => {
      if (!active) return;
      const doc = (event as CustomEvent<{ doc?: Document }>).detail?.doc;
      if (!doc || loadedDocuments.has(doc)) return;
      const currentDocuments = new Set(view.renderer?.getContents?.().map((content) => content.doc) ?? []);
      currentDocuments.add(doc);
      for (const previousDoc of loadedDocuments) {
        if (currentDocuments.has(previousDoc)) continue;
        previousDoc.removeEventListener("keydown", onKeyDown);
        previousDoc.removeEventListener("wheel", handleWheel);
        loadedDocuments.delete(previousDoc);
        wheelDocuments.delete(previousDoc);
      }
      loadedDocuments.add(doc);
      wheelDocuments.add(doc);
      doc.addEventListener("keydown", onKeyDown);
      doc.addEventListener("wheel", handleWheel, { passive: false });
    };
    const dispose = createEpubDisposer({
      view,
      documents: loadedDocuments,
      keydownHandler: onKeyDown as EventListener,
      viewListeners: [
        { type: "load", handler: handleLoad },
        { type: "relocate", handler: handleRelocate },
        { type: "external-link", handler: handleExternalLink },
      ],
    });
    const requestDispose = () => {
      disposeRequested = true;
      if (initializationFinished) dispose();
    };

    const showOpenError = () => {
      if (!active) return;
      host.replaceChildren();
      const message = document.createElement("p");
      message.className = "reader-error";
      message.textContent = tRef.current("epubOpenFailed");
      host.append(message);
    };

    const openBook = async () => {
      let failed = false;
      try {
        await view.open(file);
        if (!active) return;
        const fixedLayout = view.book?.rendition?.layout === "pre-paginated";
        onCapabilities({ typography: !fixedLayout, outline: Boolean(view.book?.toc?.length), publisherFont: !fixedLayout });
        onOutline(normalizeOutline(view.book?.toc));
        view.addEventListener("load", handleLoad);
        view.addEventListener("relocate", handleRelocate);
        view.addEventListener("external-link", handleExternalLink);
        view.renderer?.setAttribute("flow", readingProfile === "article" && !fixedLayout ? "scrolled" : "paginated");
        view.renderer?.setAttribute("max-inline-size", CONTENT_WIDTH[preferencesRef.current.contentWidth]);
        view.renderer?.setAttribute("gap", "5%");
        view.renderer?.addEventListener("wheel", handleWheel, { passive: false });
        if (!fixedLayout) view.renderer?.setStyles?.(buildEpubStyles(preferencesRef.current));
        await view.init({ lastLocation: initialLocation, showTextStart: !initialLocation });
      } catch {
        failed = active;
      } finally {
        initializationFinished = true;
        if (failed || disposeRequested || !active) dispose();
        if (failed) showOpenError();
      }
    };

    void openBook();

    navigationRef.current = {
      previous: () => void view.prev(),
      next: () => void view.next(),
      goTo: (target) => void view.goTo(target),
    };

    return () => {
      active = false;
      navigationRef.current = null;
      view.renderer?.removeEventListener("wheel", handleWheel);
      for (const doc of wheelDocuments) doc.removeEventListener("wheel", handleWheel);
      wheelDocuments.clear();
      wheelGesture.reset();
      if (relocationTimerRef.current !== undefined) window.clearTimeout(relocationTimerRef.current);
      if (pendingLocatorRef.current) onProgress(pendingLocatorRef.current);
      requestDispose();
      viewRef.current = null;
    };
  }, [file, navigationRef, onCapabilities, onCurrentTarget, onKeyDown, onLocationLabel, onOutline, onProgress, readingProfile]);

  useEffect(() => {
    preferencesRef.current = preferences;
    const view = viewRef.current;
    if (!view || view.book?.rendition?.layout === "pre-paginated") return;
    view.renderer?.setAttribute("max-inline-size", CONTENT_WIDTH[preferences.contentWidth]);
    view.renderer?.setStyles?.(buildEpubStyles(preferences));
    const cfi = currentCfiRef.current;
    if (relocationTimerRef.current !== undefined) window.clearTimeout(relocationTimerRef.current);
    if (cfi) relocationTimerRef.current = window.setTimeout(() => {
      relocationTimerRef.current = undefined;
      void view.goTo(cfi);
    }, 0);
  }, [preferences]);

  return <div className="reader-stage epub-stage" ref={hostRef} />;
}
