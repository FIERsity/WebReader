import { Languages, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import { buildStructuredTextDocument, extractMarkdownOutline, extractTextOutline, splitTextBlocks } from "../lib/textDocument";
import {
  buildTranslationRequest, createTranslationCacheRecord, hashText, requestTranslation, translationCacheKey,
} from "../lib/translation";
import { getTranslation, listTranslations, putTranslation } from "../lib/storage";
import type { ReaderPreferences, ReadingLocator, ReadingProfile } from "../types/library";
import type {
  StructuredTextDocument, TranslationAnchor, TranslationCacheRecord, TranslationTargetLanguage,
} from "../types/translation";
import { WheelGesture, normalizedWheelDelta, shouldIgnoreWheel } from "../lib/wheelPager";
import type { ReaderCapabilities, ReaderController, ReaderOutlineItem } from "../types/reader";

interface TextReaderProps {
  bookId: string;
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
  bookId, readingProfile, file, fileName, mediaType, locator, preferences, onProgress, onOutline,
  onCapabilities, onCurrentTarget, navigationRef, t,
}: TextReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef<Map<number, HTMLElement>>(new Map());
  const currentOffsetRef = useRef(locator?.type === "text" ? Number(locator.value) || 0 : 0);
  const restoringRef = useRef(false);
  const pendingSaveRef = useRef<ReadingLocator | undefined>(undefined);
  const wheelGestureRef = useRef(new WheelGesture());
  const translationAbortRef = useRef<AbortController | undefined>(undefined);
  const [text, setText] = useState("");
  const [error, setError] = useState<TranslationKey>();
  const [structuredDocument, setStructuredDocument] = useState<StructuredTextDocument>();
  const [translationConsent, setTranslationConsent] = useState(false);
  const [bilingual, setBilingual] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState<TranslationTargetLanguage>("zh-CN");
  const [translations, setTranslations] = useState<Map<string, TranslationCacheRecord>>(new Map());
  const [activeBlockId, setActiveBlockId] = useState<string>();
  const [selectionAnchor, setSelectionAnchor] = useState<TranslationAnchor>();
  const [translating, setTranslating] = useState<{ blockId: string; targetLanguage: TranslationTargetLanguage }>();
  const [translationFailed, setTranslationFailed] = useState(false);
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
    onCapabilities({ typography: true, outline: outline.length > 0, publisherFont: false });
    return () => {
      onOutline([]);
      onCapabilities({ typography: false, outline: false, publisherFont: false });
    };
  }, [markdown, onCapabilities, onOutline, text]);

  useEffect(() => {
    if (!text || readingProfile !== "article" || !import.meta.env.DEV) {
      setStructuredDocument(undefined);
      setBilingual(false);
      return;
    }
    let active = true;
    void hashText(text).then((revision) => buildStructuredTextDocument({ bookId, text, markdown, revision }))
      .then((document) => { if (active) setStructuredDocument(document); })
      .catch(() => { if (active) setTranslationFailed(true); });
    return () => { active = false; };
  }, [bookId, markdown, readingProfile, text]);

  useEffect(() => {
    const document = structuredDocument;
    if (!document || !bilingual) return;
    let active = true;
    void listTranslations(bookId, document.revision, targetLanguage).then((records) => {
      if (active) setTranslations(new Map(records.map((record) => [record.key, record])));
    }).catch(() => { if (active) setTranslationFailed(true); });
    return () => { active = false; };
  }, [bilingual, bookId, structuredDocument, targetLanguage]);

  useEffect(() => () => translationAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!bilingual) {
      translationAbortRef.current?.abort();
      setSelectionAnchor(undefined);
      window.getSelection()?.removeAllRanges();
    }
  }, [bilingual]);

  const selectedAnchor = useCallback((blockId: string, textLength: number): TranslationAnchor | undefined => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return undefined;
    const range = selection.getRangeAt(0);
    const row = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer.closest<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`)
      : range.commonAncestorContainer.parentElement?.closest<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
    const source = row?.querySelector<HTMLElement>(".bilingual-source-text");
    if (!source || !source.contains(range.startContainer) || !source.contains(range.endContainer)) return undefined;
    const startRange = document.createRange();
    startRange.selectNodeContents(source);
    startRange.setEnd(range.startContainer, range.startOffset);
    const endRange = document.createRange();
    endRange.selectNodeContents(source);
    endRange.setEnd(range.endContainer, range.endOffset);
    const start = Math.max(0, Math.min(textLength, startRange.toString().length));
    const end = Math.max(start, Math.min(textLength, endRange.toString().length));
    return end > start ? { blockId, start, end } : undefined;
  }, []);

  const translateBlock = useCallback(async (blockId: string) => {
    const document = structuredDocument;
    const block = document?.blocks.find((candidate) => candidate.id === blockId);
    if (!document || !block || translating || !translationConsent) return;
    const liveAnchor = selectedAnchor(blockId, block.text.length);
    const anchor = liveAnchor ?? { blockId, start: 0, end: block.text.length };
    const sourceText = block.text.slice(anchor.start, anchor.end);
    const requestTargetLanguage = targetLanguage;
    const controller = new AbortController();
    translationAbortRef.current?.abort();
    translationAbortRef.current = controller;
    setTranslating({ blockId, targetLanguage: requestTargetLanguage });
    setTranslationFailed(false);
    try {
      const key = await translationCacheKey({
        bookId, documentRevision: document.revision, blockId, blockText: block.text,
        start: anchor.start, end: anchor.end, targetLanguage: requestTargetLanguage,
      });
      if (controller.signal.aborted) return;
      const cached = translations.get(key) ?? await getTranslation(key);
      if (controller.signal.aborted) return;
      if (cached) {
        setTranslations((current) => new Map(current).set(cached.key, cached));
        return;
      }
      const request = buildTranslationRequest(crypto.randomUUID(), sourceText, requestTargetLanguage);
      const response = await requestTranslation(request, controller.signal);
      if (controller.signal.aborted) return;
      const record = await createTranslationCacheRecord({
        bookId, documentRevision: document.revision, blockId, blockText: block.text,
        start: anchor.start, end: anchor.end, targetLanguage: requestTargetLanguage,
        translatedText: response.translation.text,
      });
      if (controller.signal.aborted || !await putTranslation(record)) return;
      setTranslations((current) => new Map(current).set(record.key, record));
    } catch {
      setTranslationFailed(true);
    } finally {
      translationAbortRef.current = undefined;
      setTranslating(undefined);
    }
  }, [bookId, selectedAnchor, structuredDocument, targetLanguage, translating, translationConsent, translations]);

  const latestTranslationByBlock = useMemo(() => {
    const latest = new Map<string, TranslationCacheRecord>();
    for (const record of translations.values()) {
      if (record.targetLanguage !== targetLanguage) continue;
      const current = latest.get(record.anchor.blockId);
      if (!current || current.updatedAt < record.updatedAt) latest.set(record.anchor.blockId, record);
    }
    return latest;
  }, [targetLanguage, translations]);

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
  }, [bilingual, restoreOffset, targetLanguage, text, translations]);

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
      {structuredDocument && (
        <div className="translation-toolbar">
          <button
            type="button"
            className={bilingual ? "active" : ""}
            aria-pressed={bilingual}
            onClick={() => setBilingual((current) => !current)}
          ><Languages />{t("bilingualReading")}</button>
          {bilingual && !translationConsent && (
            <div className="translation-consent" role="note">
              <span>{t("translationDisclosure")}</span>
              <button type="button" onClick={() => setTranslationConsent(true)}>{t("allowTranslation")}</button>
            </div>
          )}
          {bilingual && translationConsent && (
            <div className="translation-language" role="group" aria-label={t("translationTarget")}>
              <button type="button" className={targetLanguage === "zh-CN" ? "active" : ""} aria-pressed={targetLanguage === "zh-CN"} disabled={Boolean(translating)} onClick={() => setTargetLanguage("zh-CN")}>{t("translateToChinese")}</button>
              <button type="button" className={targetLanguage === "en" ? "active" : ""} aria-pressed={targetLanguage === "en"} disabled={Boolean(translating)} onClick={() => setTargetLanguage("en")}>{t("translateToEnglish")}</button>
            </div>
          )}
          {translationFailed && <span role="status">{t("translationFailed")}</span>}
        </div>
      )}
      <article className={bilingual ? "bilingual-document" : undefined} style={{
        fontSize: `${preferences.fontSizePercent}%`,
        lineHeight: preferences.lineHeight,
        fontFamily: FONT_STACK[preferences.fontFamily],
        maxWidth: bilingual ? "1180px" : CONTENT_WIDTH[preferences.contentWidth],
      }}>
        {text ? blocks.map((block) => {
          const translated = latestTranslationByBlock.get(block.id);
          const active = activeBlockId === block.id;
          const activeSelectionLength = selectionAnchor?.blockId === block.id
            ? selectionAnchor.end - selectionAnchor.start
            : 0;
          const translatableLength = activeSelectionLength || block.text.length;
          if (bilingual && structuredDocument) {
            return (
              <section
                key={block.id}
                className={`bilingual-row ${active ? "active" : ""}`}
                data-block-id={block.id}
                ref={(node) => { if (node) blocksRef.current.set(block.start, node); else blocksRef.current.delete(block.start); }}
                onClick={(event) => {
                  if (!(event.target as Element).closest(".bilingual-source-text")) setSelectionAnchor(undefined);
                  setActiveBlockId(block.id);
                }}
              >
                <div className="bilingual-source">
                  <p
                    className="bilingual-source-text"
                    style={{ textIndent: preferences.paragraphIndent ? `${preferences.paragraphIndent}em` : undefined }}
                    onPointerUp={() => {
                      const anchor = selectedAnchor(block.id, block.text.length);
                      setSelectionAnchor(anchor);
                      setActiveBlockId(block.id);
                    }}
                    onKeyUp={() => {
                      const anchor = selectedAnchor(block.id, block.text.length);
                      setSelectionAnchor(anchor);
                      setActiveBlockId(block.id);
                    }}
                  >{block.text}</p>
                </div>
                  <div className="bilingual-translation" lang={targetLanguage} aria-label={t("translatedText")} aria-busy={translating?.blockId === block.id && translating.targetLanguage === targetLanguage}>
                  {translated ? (
                    <div className="translated-block">
                      {translated.anchor.start !== 0 || translated.anchor.end !== block.text.length
                        ? <small>{t("translatedSelection", { start: translated.anchor.start + 1, end: translated.anchor.end })}</small>
                        : null}
                      <p>{translated.translatedText}</p>
                      <button type="button" className="retranslate-button" onClick={() => void translateBlock(block.id)} disabled={!translationConsent || Boolean(translating)}>{t("translateAgain")}</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => void translateBlock(block.id)} disabled={!translationConsent || Boolean(translating) || translatableLength > 12_000}>
                      {translating?.blockId === block.id && translating.targetLanguage === targetLanguage ? <LoaderCircle className="spin" /> : <Languages />}
                      {translatableLength > 12_000
                        ? t("translationUnitTooLong")
                        : translating?.blockId === block.id && translating.targetLanguage === targetLanguage ? t("translating") : t("translateParagraph")}
                    </button>
                  )}
                </div>
              </section>
            );
          }
          return (
            <p
              key={block.id}
              ref={(node) => { if (node) blocksRef.current.set(block.start, node); else blocksRef.current.delete(block.start); }}
              style={{ textIndent: preferences.paragraphIndent ? `${preferences.paragraphIndent}em` : undefined }}
            >
              {block.text}
            </p>
          );
        }) : t("loadingText")}
      </article>
    </div>
  );
}
