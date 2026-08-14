import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import { extractMarkdownOutline, extractTextOutline, splitTextBlocks } from "../lib/textDocument";
import {
  calculateTextPageLayout,
  findSourceRangeIndex,
  pageCountForExtent,
  pageIndexAtPosition,
  sourceOffsetForRange,
  type TextPageLayout,
} from "../lib/textPagination";
import type { ReaderPreferences, ReadingLocator, ReadingProfile } from "../types/library";
import { WheelGesture, normalizedWheelDelta, shouldIgnoreWheel } from "../lib/wheelPager";
import { findTextMatches, throwIfSearchAborted } from "../lib/readerSearch";
import type { ReaderCapabilities, ReaderController, ReaderOutlineItem, ReaderSearchResult } from "../types/reader";

interface TextReaderProps {
  layoutRevision?: string;
  readingProfile: ReadingProfile;
  file: Blob;
  fileName: string;
  mediaType: string;
  locator?: ReadingLocator;
  preferences: ReaderPreferences;
  onProgress: (locator: ReadingLocator) => void;
  onOutline: (items: ReaderOutlineItem[], automatic?: boolean) => void;
  onCapabilities: (capabilities: ReaderCapabilities) => void;
  onCurrentTarget: (target?: string) => void;
  navigationRef: React.RefObject<ReaderController | null>;
  t: (key: TranslationKey, variables?: TranslationVariables) => string;
}

const FONT_STACK = {
  publisher: 'Georgia, "Songti SC", "Noto Serif CJK SC", serif',
  serif: 'Georgia, "Songti SC", "Noto Serif CJK SC", serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif',
} as const;
const CONTENT_WIDTH = { narrow: 600, standard: 720, wide: 880 } as const;

async function decodeText(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buffer);
    } catch {
      return new TextDecoder().decode(buffer);
    }
  }
}

function textNodeFor(element: HTMLElement): Text | undefined {
  const node = element.firstChild;
  return node?.nodeType === Node.TEXT_NODE ? node as Text : undefined;
}

function rangeRectAtOffset(element: HTMLElement, offset: number): DOMRect | undefined {
  const textNode = textNodeFor(element);
  if (!textNode?.length) return undefined;
  const localOffset = Math.min(textNode.length, Math.max(0, offset));
  const range = textNode.ownerDocument.createRange();
  if (localOffset < textNode.length) {
    range.setStart(textNode, localOffset);
    range.setEnd(textNode, localOffset + 1);
  } else {
    range.setStart(textNode, textNode.length - 1);
    range.setEnd(textNode, textNode.length);
  }
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
  return localOffset < textNode.length ? rects[0] : rects.at(-1);
}

function samePageLayout(left: TextPageLayout | undefined, right: TextPageLayout): boolean {
  return Boolean(left
    && left.viewportWidth === right.viewportWidth
    && left.contentWidth === right.contentWidth
    && left.contentHeight === right.contentHeight
    && left.sideInset === right.sideInset
    && left.topInset === right.topInset
    && left.bottomInset === right.bottomInset);
}

export function TextReader({
  layoutRevision, readingProfile, file, fileName, mediaType, locator, preferences, onProgress, onOutline,
  onCapabilities, onCurrentTarget, navigationRef, t,
}: TextReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const blocksRef = useRef<Map<number, HTMLElement>>(new Map());
  const currentOffsetRef = useRef(locator?.type === "text" ? Number(locator.value) || 0 : 0);
  const restoringRef = useRef(false);
  const restoreFrameRef = useRef(0);
  const pendingSaveRef = useRef<ReadingLocator | undefined>(undefined);
  const saveTimerRef = useRef(0);
  const scrollFrameRef = useRef(0);
  const wheelGestureRef = useRef(new WheelGesture());
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  const [pageLayout, setPageLayout] = useState<TextPageLayout>();
  const [pageTrackWidth, setPageTrackWidth] = useState(0);
  const [activeSearchMatch, setActiveSearchMatch] = useState<{ start: number; end: number }>();
  const blocks = useMemo(() => splitTextBlocks(text), [text]);
  const hasReadableText = text.trim().length > 0;
  const markdown = mediaType === "text/markdown" || /\.md$/i.test(fileName);
  const paginated = readingProfile === "book";

  useEffect(() => {
    let active = true;
    setText("");
    setLoaded(false);
    setError(undefined);
    void decodeText(file).then((value) => {
      if (active) {
        setText(value.replace(/^\uFEFF/, ""));
        setLoaded(true);
      }
    }).catch(() => {
      if (active) {
        setError("textDecodeFailed");
        setLoaded(true);
      }
    });
    return () => { active = false; };
  }, [file]);

  useEffect(() => {
    if (!text) return;
    const outline = markdown ? extractMarkdownOutline(text) : extractTextOutline(text);
    onOutline(outline, !markdown && outline.length > 0);
    onCapabilities({ typography: true, outline: outline.length > 0, publisherFont: false, readingProfile: true, paginated, search: true });
    return () => {
      onOutline([]);
      onCapabilities({ typography: false, outline: false, publisherFont: false, readingProfile: false, paginated: false, search: false });
    };
  }, [markdown, onCapabilities, onOutline, paginated, text]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      const next = calculateTextPageLayout(
        element.clientWidth,
        element.clientHeight,
        CONTENT_WIDTH[preferences.contentWidth],
      );
      setPageLayout((current) => samePageLayout(current, next) ? current : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [layoutRevision, paginated, preferences.contentWidth]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const article = articleRef.current;
    if (!element || !article || !pageLayout || !paginated) {
      setPageTrackWidth(0);
      return;
    }
    const update = () => setPageTrackWidth(pageCountForExtent(article.scrollWidth, pageLayout.viewportWidth) * pageLayout.viewportWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(article);
    return () => observer.disconnect();
  }, [blocks, pageLayout, paginated, preferences.fontFamily, preferences.fontSizePercent, preferences.lineHeight, preferences.paragraphIndent]);

  const activeBlockAtOffset = useCallback((offset: number) => {
    const index = findSourceRangeIndex(blocks, offset);
    return index >= 0 ? blocks[index] : undefined;
  }, [blocks]);

  const pageForOffset = useCallback((offset: number) => {
    const element = scrollRef.current;
    const article = articleRef.current;
    if (!element || !article || !pageLayout || blocks.length === 0) return 0;
    const source = sourceOffsetForRange(blocks, offset);
    if (!source) return 0;
    const block = blocks[source.index];
    const node = block ? blocksRef.current.get(block.start) : undefined;
    const rect = node && block ? rangeRectAtOffset(node, source.offset - block.start) : undefined;
    if (!rect) return 0;
    const containerRect = element.getBoundingClientRect();
    const absoluteLeft = rect.left - containerRect.left + element.scrollLeft;
    const pageCount = pageCountForExtent(article.scrollWidth, pageLayout.viewportWidth);
    return Math.min(pageCount - 1, Math.max(0, Math.floor(absoluteLeft / pageLayout.viewportWidth)));
  }, [blocks, pageLayout]);

  const offsetForPage = useCallback((page: number) => {
    if (blocks.length === 0 || text.length === 0 || page <= 0) return blocks[0]?.start ?? 0;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (pageForOffset(middle) >= page) high = middle;
      else low = middle + 1;
    }
    return sourceOffsetForRange(blocks, low)?.offset ?? low;
  }, [blocks, pageForOffset, text.length]);

  const queueProgress = useCallback((offset: number, progression: number) => {
    const normalizedProgression = Math.min(1, Math.max(0, progression));
    const next: ReadingLocator = {
      type: "text",
      value: String(offset),
      progression: normalizedProgression,
      label: `${Math.round(normalizedProgression * 100)}%`,
    };
    currentOffsetRef.current = offset;
    pendingSaveRef.current = next;
    onCurrentTarget(String(activeBlockAtOffset(offset)?.start ?? offset));
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => onProgress(next), 250);
  }, [activeBlockAtOffset, onCurrentTarget, onProgress]);

  const reportScrollLocation = useCallback(() => {
    const element = scrollRef.current;
    if (!element || blocks.length === 0) return;
    const top = element.scrollTop + 32;
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const node = blocksRef.current.get(blocks[middle]!.start);
      if (node && node.offsetTop <= top) low = middle + 1;
      else high = middle;
    }
    const activeBlock = blocks[Math.max(0, low - 1)];
    const maximum = Math.max(1, element.scrollHeight - element.clientHeight);
    const progression = Math.max(0, Math.min(1, element.scrollTop / maximum));
    const node = activeBlock ? blocksRef.current.get(activeBlock.start) : undefined;
    const withinBlock = node && node.offsetHeight > 0
      ? Math.min(1, Math.max(0, (top - node.offsetTop) / node.offsetHeight))
      : 0;
    const offset = activeBlock
      ? Math.min(activeBlock.end, Math.round(activeBlock.start + withinBlock * activeBlock.text.length))
      : Math.round(progression * text.length);
    queueProgress(offset, progression);
  }, [blocks, queueProgress, text.length]);

  const reportPageLocation = useCallback(() => {
    const element = scrollRef.current;
    const article = articleRef.current;
    if (!element || !article || !pageLayout) return;
    const pageCount = pageCountForExtent(article.scrollWidth, pageLayout.viewportWidth);
    const page = pageIndexAtPosition(element.scrollLeft, pageLayout.viewportWidth, pageCount);
    const offset = offsetForPage(page);
    const progression = pageCount > 1 ? page / (pageCount - 1) : 0;
    queueProgress(offset, progression);
  }, [offsetForPage, pageLayout, queueProgress]);

  const restoreOffset = useCallback((offset: number) => {
    const element = scrollRef.current;
    if (!element || blocks.length === 0) return;
    const block = activeBlockAtOffset(offset) ?? blocks[0];
    const node = block ? blocksRef.current.get(block.start) : undefined;
    if (!node || !block) return;
    restoringRef.current = true;
    window.cancelAnimationFrame(restoreFrameRef.current);
    if (paginated && pageLayout) {
      const page = pageForOffset(offset);
      element.scrollTo({ left: page * pageLayout.viewportWidth, top: 0, behavior: "auto" });
    } else {
      const fraction = block.text.length > 0 ? Math.min(1, Math.max(0, (offset - block.start) / block.text.length)) : 0;
      const withinBlock = node.offsetHeight * fraction;
      element.scrollTo({ left: 0, top: Math.max(0, node.offsetTop - 32 + withinBlock), behavior: "auto" });
    }
    onCurrentTarget(String(block.start));
    restoreFrameRef.current = window.requestAnimationFrame(() => { restoringRef.current = false; });
  }, [activeBlockAtOffset, blocks, onCurrentTarget, pageForOffset, pageLayout, paginated]);

  useLayoutEffect(() => {
    if (!text || !pageLayout) return;
    restoreOffset(currentOffsetRef.current);
    const frame = window.requestAnimationFrame(() => {
      if (paginated) reportPageLocation();
      else reportScrollLocation();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pageLayout, pageTrackWidth, paginated, preferences.fontFamily, preferences.fontSizePercent, preferences.lineHeight, preferences.paragraphIndent, reportPageLocation, reportScrollLocation, restoreOffset, text]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const save = () => {
      if (restoringRef.current) return;
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        if (restoringRef.current) return;
        if (paginated) reportPageLocation();
        else reportScrollLocation();
      });
    };
    element.addEventListener("scroll", save, { passive: true });
    return () => {
      window.cancelAnimationFrame(scrollFrameRef.current);
      element.removeEventListener("scroll", save);
    };
  }, [paginated, reportPageLocation, reportScrollLocation]);

  const turnPage = useCallback((direction: "previous" | "next") => {
    const element = scrollRef.current;
    const article = articleRef.current;
    if (!element || !article || !pageLayout) return;
    const pageCount = pageCountForExtent(article.scrollWidth, pageLayout.viewportWidth);
    const currentPage = pageIndexAtPosition(element.scrollLeft, pageLayout.viewportWidth, pageCount);
    const nextPage = Math.min(pageCount - 1, Math.max(0, currentPage + (direction === "previous" ? -1 : 1)));
    if (nextPage === currentPage) return;
    restoringRef.current = false;
    element.scrollTo({ left: nextPage * pageLayout.viewportWidth, top: 0, behavior: "auto" });
    reportPageLocation();
  }, [pageLayout, reportPageLocation]);

  const navigateToOffset = useCallback((offset: number) => {
    const normalizedOffset = Math.min(text.length, Math.max(0, offset));
    const progression = text.length > 0 ? normalizedOffset / text.length : 0;
    currentOffsetRef.current = normalizedOffset;
    queueProgress(normalizedOffset, progression);
    restoreOffset(normalizedOffset);
    window.requestAnimationFrame(() => {
      if (paginated) reportPageLocation();
      else reportScrollLocation();
    });
  }, [paginated, queueProgress, reportPageLocation, reportScrollLocation, restoreOffset, text.length]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !paginated) return;
    const handleWheel = (event: WheelEvent) => {
      if (shouldIgnoreWheel(event)) return;
      const delta = normalizedWheelDelta(event, element.clientWidth);
      if (!delta) return;
      event.preventDefault();
      const direction = wheelGestureRef.current.push(delta, event.timeStamp);
      if (direction) turnPage(direction);
    };
    const gesture = wheelGestureRef.current;
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", handleWheel);
      gesture.reset();
    };
  }, [paginated, turnPage]);

  useEffect(() => {
    navigationRef.current = {
      previous: () => {
        if (paginated) turnPage("previous");
        else scrollRef.current?.scrollBy({ top: -(scrollRef.current.clientHeight * 0.86), behavior: "smooth" });
      },
      next: () => {
        if (paginated) turnPage("next");
        else scrollRef.current?.scrollBy({ top: scrollRef.current.clientHeight * 0.86, behavior: "smooth" });
      },
      goTo: (target) => {
        const offset = Number(target);
        if (!Number.isFinite(offset)) return;
        setActiveSearchMatch(undefined);
        navigateToOffset(offset);
      },
      search: async (query, options) => {
        setActiveSearchMatch(undefined);
        throwIfSearchAborted(options.signal);
        const outcome = findTextMatches(text, query, { maxResults: options.maxResults, idPrefix: "text" });
        options.onProgress?.(1);
        throwIfSearchAborted(options.signal);
        return outcome;
      },
      goToSearch: (result: ReaderSearchResult) => {
        const start = Number(result.target);
        if (!Number.isFinite(start)) return;
        setActiveSearchMatch({ start, end: start + result.excerpt.match.length });
        navigateToOffset(start);
      },
      clearSearch: () => setActiveSearchMatch(undefined),
    };
    return () => { navigationRef.current = null; };
  }, [navigateToOffset, navigationRef, paginated, text, turnPage]);

  useEffect(() => () => {
    window.cancelAnimationFrame(restoreFrameRef.current);
    window.cancelAnimationFrame(scrollFrameRef.current);
    window.clearTimeout(saveTimerRef.current);
    if (pendingSaveRef.current) onProgress(pendingSaveRef.current);
  }, [onProgress]);

  if (error) return <p className="reader-error">{t(error)}</p>;

  const articleStyle = {
    fontSize: `${preferences.fontSizePercent}%`,
    lineHeight: preferences.lineHeight,
    fontFamily: FONT_STACK[preferences.fontFamily],
    maxWidth: paginated ? undefined : `${CONTENT_WIDTH[preferences.contentWidth]}px`,
    textIndent: undefined,
    "--text-page-width": pageLayout ? `${pageLayout.viewportWidth}px` : "100%",
    "--text-content-width": pageLayout ? `${pageLayout.contentWidth}px` : `${CONTENT_WIDTH[preferences.contentWidth]}px`,
    "--text-page-side-inset": pageLayout ? `${pageLayout.sideInset}px` : "82px",
    "--text-page-top-inset": pageLayout ? `${pageLayout.topInset}px` : "52px",
    "--text-page-bottom-inset": pageLayout ? `${pageLayout.bottomInset}px` : "100px",
  } as React.CSSProperties & Record<`--${string}`, string>;

  return (
    <div className={`reader-stage text-stage text-stage-${paginated ? "paged" : "scroll"} theme-${preferences.theme}`} ref={scrollRef}>
      {paginated && pageTrackWidth > 0 && <span className="text-page-track" aria-hidden="true" style={{ width: `${pageTrackWidth}px` }} />}
      <article ref={articleRef} style={articleStyle}>
        {hasReadableText ? blocks.map((block) => {
          const matchStart = activeSearchMatch ? Math.max(block.start, activeSearchMatch.start) : block.end;
          const matchEnd = activeSearchMatch ? Math.min(block.end, activeSearchMatch.end) : block.start;
          const hasMatch = matchStart < matchEnd;
          const localStart = Math.max(0, matchStart - block.start);
          const localEnd = Math.max(localStart, matchEnd - block.start);
          return (
          <p
            key={block.id}
            ref={(node) => { if (node) blocksRef.current.set(block.start, node); else blocksRef.current.delete(block.start); }}
            style={{ textIndent: preferences.paragraphIndent ? `${preferences.paragraphIndent}em` : undefined }}
          >
            {hasMatch ? <>{block.text.slice(0, localStart)}<mark className="text-search-highlight">{block.text.slice(localStart, localEnd)}</mark>{block.text.slice(localEnd)}</> : block.text}
          </p>
          );
        }) : loaded ? t("emptyText") : t("loadingText")}
      </article>
    </div>
  );
}
