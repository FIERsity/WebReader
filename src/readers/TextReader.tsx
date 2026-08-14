import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import {
  parseMarkdownBlock,
  type MarkdownBlock,
  type MarkdownInlineNode,
} from "../lib/markdownDocument";
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

function rangeRectAtOffset(element: HTMLElement, offset: number): DOMRect | undefined {
  const candidates = [...element.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")]
    .map((node) => ({
      node,
      start: Number(node.dataset.sourceStart),
      end: Number(node.dataset.sourceEnd),
    }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end >= start);
  const mapped = candidates.find(({ start, end }) => offset >= start && offset < end)
    ?? candidates.find(({ end }) => offset === end)
    ?? candidates.reduce<{ node: HTMLElement; start: number; end: number } | undefined>((closest, candidate) => {
      if (!closest) return candidate;
      const candidateDistance = offset < candidate.start ? candidate.start - offset : offset - candidate.end;
      const closestDistance = offset < closest.start ? closest.start - offset : offset - closest.end;
      return candidateDistance < closestDistance ? candidate : closest;
    }, undefined);
  const root = mapped?.node ?? element;
  const walker = element.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current.nodeType === Node.TEXT_NODE && (current.textContent?.length ?? 0) > 0) textNodes.push(current as Text);
  }
  if (textNodes.length === 0) return undefined;
  const totalLength = textNodes.reduce((length, node) => length + node.length, 0);
  const sourceLength = mapped ? mapped.end - mapped.start : totalLength;
  const localOffset = mapped && sourceLength === totalLength
    ? Math.min(totalLength, Math.max(0, offset - mapped.start))
    : offset <= (mapped?.start ?? offset) ? 0 : totalLength;
  let remaining = localOffset;
  let textNode = textNodes[0]!;
  for (const node of textNodes) {
    if (remaining <= node.length) {
      textNode = node;
      break;
    }
    remaining -= node.length;
    textNode = node;
  }
  const range = textNode.ownerDocument.createRange();
  const localTextOffset = Math.min(textNode.length, Math.max(0, remaining));
  if (localTextOffset < textNode.length) {
    range.setStart(textNode, localTextOffset);
    range.setEnd(textNode, localTextOffset + 1);
  } else {
    range.setStart(textNode, textNode.length - 1);
    range.setEnd(textNode, textNode.length);
  }
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
  return localTextOffset < textNode.length ? rects[0] : rects.at(-1);
}

type ActiveTextMatch = { start: number; end: number };

function renderSourceText(text: string, start: number, end: number, activeMatch?: ActiveTextMatch): ReactNode {
  if (!text) return null;
  const sourceLength = Math.max(0, end - start);
  const exactMapping = sourceLength === text.length;
  const overlapStart = activeMatch && exactMapping ? Math.max(start, activeMatch.start) : end;
  const overlapEnd = activeMatch && exactMapping ? Math.min(end, activeMatch.end) : start;
  const hasMatch = overlapStart < overlapEnd;
  if (!hasMatch) {
    return <span data-source-start={start} data-source-end={end}>{text}</span>;
  }
  const localStart = overlapStart - start;
  const localEnd = overlapEnd - start;
  return (
    <span data-source-start={start} data-source-end={end}>
      {text.slice(0, localStart)}
      <mark className="text-search-highlight">{text.slice(localStart, localEnd)}</mark>
      {text.slice(localEnd)}
    </span>
  );
}

function renderMarkdownInline(nodes: MarkdownInlineNode[], activeMatch?: ActiveTextMatch): ReactNode[] {
  return nodes.map((node) => {
    const key = `${node.type}:${node.start}:${node.end}`;
    if (node.type === "text" || node.type === "code") {
      return <span className={node.type === "code" ? "markdown-inline-code" : undefined} key={key}>{renderSourceText(node.text, node.start, node.end, activeMatch)}</span>;
    }
    if (node.type === "strong") return <strong key={key}>{renderMarkdownInline(node.children, activeMatch)}</strong>;
    if (node.type === "emphasis") return <em key={key}>{renderMarkdownInline(node.children, activeMatch)}</em>;
    if (node.type === "delete") return <del key={key}>{renderMarkdownInline(node.children, activeMatch)}</del>;
    if (node.type === "link") {
      return <span className="markdown-link" key={key} title={node.href}>{renderMarkdownInline(node.children, activeMatch)}</span>;
    }
    if (node.type === "image") {
      return <span className="markdown-image-alt" key={key} aria-label={node.alt || "Image"}>{renderSourceText(node.alt || "Image", node.altStart, node.altEnd, activeMatch)}</span>;
    }
    return <br key={key} aria-hidden="true" />;
  });
}

interface MarkdownBlockViewProps {
  block: MarkdownBlock;
  activeMatch?: ActiveTextMatch;
  paragraphIndent: ReaderPreferences["paragraphIndent"];
  register: (node: HTMLElement | null) => void;
}

function MarkdownBlockView({ block, activeMatch, paragraphIndent, register }: MarkdownBlockViewProps) {
  const inline = block.inlineNodes ?? [];
  if (block.markdownKind === "heading") {
    const content = renderMarkdownInline(inline, activeMatch);
    if (block.headingLevel === 1) return <h1 ref={register} className="markdown-heading" key={block.id}>{content}</h1>;
    if (block.headingLevel === 2) return <h2 ref={register} className="markdown-heading" key={block.id}>{content}</h2>;
    if (block.headingLevel === 3) return <h3 ref={register} className="markdown-heading" key={block.id}>{content}</h3>;
    if (block.headingLevel === 4) return <h4 ref={register} className="markdown-heading" key={block.id}>{content}</h4>;
    if (block.headingLevel === 5) return <h5 ref={register} className="markdown-heading" key={block.id}>{content}</h5>;
    return <h6 ref={register} className="markdown-heading" key={block.id}>{content}</h6>;
  }
  if (block.markdownKind === "code") {
    const code = renderSourceText(block.codeText ?? "", block.codeStart ?? block.start, block.codeEnd ?? block.end, activeMatch);
    return <pre ref={register} className="markdown-code" key={block.id} data-language={block.codeLanguage}><code>{code}</code></pre>;
  }
  if (block.markdownKind === "list") {
    const List = block.orderedList ? "ol" : "ul";
    return (
      <List ref={register} className="markdown-list" key={block.id}>
        {(block.listItems ?? []).map((item) => (
          <li key={`${block.id}:${item.start}`} style={{ marginInlineStart: `${item.depth * 1.25}em` }}>
            {item.lines.map((line, index) => (
              <span className="markdown-list-line" key={`${item.start}:${index}`}>
                {index > 0 && <br />}
                {renderMarkdownInline(line, activeMatch)}
              </span>
            ))}
          </li>
        ))}
      </List>
    );
  }
  if (block.markdownKind === "quote") {
    return (
      <blockquote ref={register} className="markdown-quote" key={block.id}>
        {(block.quoteLines ?? []).map((line, index) => <p key={`${block.id}:${index}`}>{renderMarkdownInline(line, activeMatch)}</p>)}
      </blockquote>
    );
  }
  if (block.markdownKind === "thematic-break") return <hr ref={register} className="markdown-rule" key={block.id} />;
  return <p ref={register} className="markdown-paragraph" key={block.id} style={{ textIndent: paragraphIndent ? `${paragraphIndent}em` : undefined }}>{renderMarkdownInline(inline, activeMatch)}</p>;
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
  const hasReadableText = text.trim().length > 0;
  const markdown = mediaType === "text/markdown" || /\.md$/i.test(fileName);
  const paginated = readingProfile === "book";
  const blocks = useMemo(() => {
    const parsed = splitTextBlocks(text);
    return markdown ? parsed.map(parseMarkdownBlock) : parsed;
  }, [markdown, text]);

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
          const register = (node: HTMLElement | null) => {
            if (node) blocksRef.current.set(block.start, node);
            else blocksRef.current.delete(block.start);
          };
          const activeMatch = activeSearchMatch && activeSearchMatch.start < block.end && activeSearchMatch.end > block.start
            ? activeSearchMatch
            : undefined;
          if (markdown && "markdownKind" in block) {
            return <MarkdownBlockView key={block.id} block={block as MarkdownBlock} activeMatch={activeMatch} paragraphIndent={preferences.paragraphIndent} register={register} />;
          }
          return <p key={block.id} ref={register} style={{ textIndent: preferences.paragraphIndent ? `${preferences.paragraphIndent}em` : undefined }}>{renderSourceText(block.text, block.start, block.end, activeMatch)}</p>;
        }) : loaded ? t("emptyText") : t("loadingText")}
      </article>
    </div>
  );
}
