import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import { extractMarkdownOutline, extractTextOutline, splitTextBlocks } from "../lib/textDocument";
import type { ReaderPreferences, ReadingLocator, ReadingProfile } from "../types/library";
import { WheelGesture, normalizedWheelDelta, shouldIgnoreWheel } from "../lib/wheelPager";
import type { ReaderCapabilities, ReaderController, ReaderOutlineItem } from "../types/reader";

interface TextReaderProps {
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
const CONTENT_WIDTH = { narrow: "600px", standard: "720px", wide: "880px" } as const;

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

export function TextReader({
  readingProfile, file, fileName, mediaType, locator, preferences, onProgress, onOutline,
  onCapabilities, onCurrentTarget, navigationRef, t,
}: TextReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef<Map<number, HTMLElement>>(new Map());
  const currentOffsetRef = useRef(locator?.type === "text" ? Number(locator.value) || 0 : 0);
  const restoringRef = useRef(false);
  const pendingSaveRef = useRef<ReadingLocator | undefined>(undefined);
  const wheelGestureRef = useRef(new WheelGesture());
  const [text, setText] = useState("");
  const [error, setError] = useState<TranslationKey>();
  const blocks = useMemo(() => splitTextBlocks(text), [text]);
  const markdown = mediaType === "text/markdown" || /\.md$/i.test(fileName);

  useEffect(() => {
    let active = true;
    void decodeText(file).then((value) => {
      if (active) setText(value.replace(/^\uFEFF/, ""));
    }).catch(() => {
      if (active) setError("textDecodeFailed");
    });
    return () => { active = false; };
  }, [file]);

  useEffect(() => {
    if (!text) return;
    const outline = markdown ? extractMarkdownOutline(text) : extractTextOutline(text);
    onOutline(outline, !markdown && outline.length > 0);
    onCapabilities({ typography: true, outline: outline.length > 0, publisherFont: false, readingProfile: true, paginated: readingProfile === "book" });
    return () => {
      onOutline([]);
      onCapabilities({ typography: false, outline: false, publisherFont: false, readingProfile: false, paginated: false });
    };
  }, [markdown, onCapabilities, onOutline, readingProfile, text]);

  const restoreOffset = useCallback((offset: number) => {
    const element = scrollRef.current;
    if (!element || blocks.length === 0) return;
    const block = [...blocks].reverse().find((candidate) => candidate.start <= offset) ?? blocks[0];
    const node = block ? blocksRef.current.get(block.start) : undefined;
    if (!node) return;
    restoringRef.current = true;
    const fraction = block.text.length > 0 ? Math.min(1, Math.max(0, (offset - block.start) / block.text.length)) : 0;
    const withinBlock = node.offsetHeight * fraction;
    element.scrollTop = Math.max(0, node.offsetTop - 32 + withinBlock);
    requestAnimationFrame(() => { restoringRef.current = false; });
  }, [blocks]);

  useEffect(() => {
    if (!text) return;
    requestAnimationFrame(() => restoreOffset(currentOffsetRef.current));
  }, [restoreOffset, text]);

  useEffect(() => {
    if (!text) return;
    const offset = currentOffsetRef.current;
    requestAnimationFrame(() => restoreOffset(offset));
  }, [preferences, restoreOffset, text]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let timer = 0;
    const save = () => {
      if (restoringRef.current) return;
      const top = element.scrollTop + 32;
      let activeBlock = blocks[0];
      for (const block of blocks) {
        const node = blocksRef.current.get(block.start);
        if (node && node.offsetTop <= top) activeBlock = block;
        else if (node) break;
      }
      const maximum = Math.max(1, element.scrollHeight - element.clientHeight);
      const progression = Math.max(0, Math.min(1, element.scrollTop / maximum));
      const node = activeBlock ? blocksRef.current.get(activeBlock.start) : undefined;
      const withinBlock = node && node.offsetHeight > 0
        ? Math.min(1, Math.max(0, (top - node.offsetTop) / node.offsetHeight))
        : 0;
      const offset = activeBlock
        ? Math.min(activeBlock.start + activeBlock.text.length, Math.round(activeBlock.start + withinBlock * activeBlock.text.length))
        : Math.round(progression * text.length);
      currentOffsetRef.current = offset;
      const next: ReadingLocator = { type: "text", value: String(offset), progression, label: `${Math.round(progression * 100)}%` };
      pendingSaveRef.current = next;
      onCurrentTarget(String(activeBlock?.start ?? offset));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => onProgress(next), 250);
    };
    element.addEventListener("scroll", save, { passive: true });
    return () => {
      window.clearTimeout(timer);
      if (pendingSaveRef.current) onProgress(pendingSaveRef.current);
      element.removeEventListener("scroll", save);
    };
  }, [blocks, onCurrentTarget, onProgress, text.length]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || readingProfile === "article") return;
    const handleWheel = (event: WheelEvent) => {
      if (shouldIgnoreWheel(event)) return;
      const delta = normalizedWheelDelta(event, element.clientHeight);
      if (!delta) return;
      event.preventDefault();
      const direction = wheelGestureRef.current.push(delta, event.timeStamp);
      if (!direction) return;
      element.scrollTop += (direction === "previous" ? -1 : 1) * element.clientHeight * 0.86;
    };
    const gesture = wheelGestureRef.current;
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", handleWheel);
      gesture.reset();
    };
  }, [readingProfile]);

  useLayoutEffect(() => {
    if (!text) return;
    restoreOffset(currentOffsetRef.current);
  }, [restoreOffset, text]);

  useEffect(() => {
    navigationRef.current = {
      previous: () => scrollRef.current?.scrollBy({ top: -(scrollRef.current.clientHeight * 0.86), behavior: "smooth" }),
      next: () => scrollRef.current?.scrollBy({ top: scrollRef.current.clientHeight * 0.86, behavior: "smooth" }),
      goTo: (target) => {
        const offset = Number(target);
        if (Number.isFinite(offset)) {
          currentOffsetRef.current = offset;
          const outlineBlock = [...blocks].reverse().find((block) => block.start <= offset);
          const progression = text.length > 0 ? Math.min(1, Math.max(0, offset / text.length)) : 0;
          const next: ReadingLocator = { type: "text", value: String(offset), progression, label: `${Math.round(progression * 100)}%` };
          pendingSaveRef.current = next;
          onCurrentTarget(String(outlineBlock?.start ?? offset));
          onProgress(next);
          restoreOffset(offset);
        }
      },
    };
    return () => { navigationRef.current = null; };
  }, [blocks, navigationRef, onCurrentTarget, onProgress, restoreOffset, text.length]);

  if (error) return <p className="reader-error">{t(error)}</p>;

  return (
    <div className={`reader-stage text-stage theme-${preferences.theme}`} ref={scrollRef}>
      <article style={{
        fontSize: `${preferences.fontSizePercent}%`,
        lineHeight: preferences.lineHeight,
        fontFamily: FONT_STACK[preferences.fontFamily],
        maxWidth: CONTENT_WIDTH[preferences.contentWidth],
      }}>
        {text ? blocks.map((block) => (
          <p
            key={block.id}
            ref={(node) => { if (node) blocksRef.current.set(block.start, node); else blocksRef.current.delete(block.start); }}
            style={{ textIndent: preferences.paragraphIndent ? `${preferences.paragraphIndent}em` : undefined }}
          >
            {block.text}
          </p>
        )) : t("loadingText")}
      </article>
    </div>
  );
}
