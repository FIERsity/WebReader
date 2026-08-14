import { Columns2, FileText, LoaderCircle, Rows3 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  GlobalWorkerOptions, getDocument, TextLayer, type PDFDocumentProxy, type PDFPageProxy,
} from "pdfjs-dist";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import { parsePdfLocation, serializePdfLocation } from "../lib/pdfLocation";
import {
  buildPdfPageLayout, locatePdfPosition, pdfWindowForPage, scrollTopForPdfLocation,
} from "../lib/pdfLayout";
import { getPdfOutline } from "../lib/pdfOutline";
import { fitsCanvasLimit, MAX_PDF_CANVAS_PIXELS } from "../lib/pdfLimits";
import {
  MAX_PDF_SEARCH_CHARACTERS, MAX_PDF_SEARCH_ITEMS_PER_PAGE, MAX_PDF_SEARCH_PAGES,
  searchPdfTextItems, type PdfSearchTextItem,
} from "../lib/pdfSearch";
import { throwIfSearchAborted } from "../lib/readerSearch";
import {
  analyzePdfTextPage, buildPdfPaperDocument, MAX_PDF_ANALYSIS_CHARACTERS, MAX_PDF_ANALYSIS_PAGES,
  type PdfPaperBlock, type PdfPaperDocument, type PdfRawTextItem,
} from "../lib/pdfText";
import { WheelGesture, normalizedWheelDelta, shouldIgnoreWheel } from "../lib/wheelPager";
import type { ReaderPreferences, ReadingLocator, ReadingProfile } from "../types/library";
import type { ReaderCapabilities, ReaderController, ReaderOutlineItem } from "../types/reader";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const pageRenderLeases = new WeakMap<PDFPageProxy, number>();

function acquirePageLease(page: PDFPageProxy): () => void {
  pageRenderLeases.set(page, (pageRenderLeases.get(page) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (pageRenderLeases.get(page) ?? 1) - 1;
    if (remaining <= 0) {
      pageRenderLeases.delete(page);
      window.setTimeout(() => {
        if (!pageRenderLeases.has(page)) page.cleanup();
      }, 0);
    } else pageRenderLeases.set(page, remaining);
  };
}

interface PdfReaderProps {
  readingProfile: ReadingProfile;
  file: Blob;
  locator?: ReadingLocator;
  preferences: ReaderPreferences;
  onProgress: (locator: ReadingLocator) => void;
  onOutline: (items: ReaderOutlineItem[], automatic?: boolean) => void;
  onCapabilities: (capabilities: ReaderCapabilities) => void;
  onCurrentTarget: (target?: string) => void;
  navigationRef: React.RefObject<ReaderController | null>;
  t: (key: TranslationKey, variables?: TranslationVariables) => string;
}

interface PdfAnalysisState {
  status: "idle" | "running" | "ready" | "failed" | "cancelled";
  completedPages: number;
  totalPages: number;
  document?: PdfPaperDocument;
}

interface PdfJsTextItem {
  str: string;
  dir: string;
  transform: Array<number>;
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

function isTextItem(item: unknown): item is PdfJsTextItem {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

function toRawTextItem(item: PdfJsTextItem, sourceIndex: number, viewport: ReturnType<PDFPageProxy["getViewport"]>): PdfRawTextItem {
  const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = item.transform;
  const [va = 0, vb = 0, vc = 0, vd = 0, ve = 0, vf = 0] = viewport.transform;
  return {
    sourceIndex,
    str: item.str,
    dir: item.dir,
    transform: [
      va * a + vc * b,
      vb * a + vd * b,
      va * c + vc * d,
      vb * c + vd * d,
      va * x + vc * y + ve,
      vb * x + vd * y + vf,
    ],
    width: item.width,
    height: item.height,
    fontName: item.fontName,
    hasEOL: item.hasEOL,
    coordinateSpace: "viewport",
  };
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function toPdfSearchTextItem(
  item: PdfJsTextItem,
  sourceIndex: number,
  pageNumber: number,
  viewport: ReturnType<PDFPageProxy["getViewport"]>,
): PdfSearchTextItem | undefined {
  if (!item.str.trim()) return undefined;
  const raw = toRawTextItem(item, sourceIndex, viewport);
  const [a = 0, b = 0, c = 0, d = 0, x = 0, baseline = 0] = raw.transform;
  const fontHeight = Math.max(1, raw.height || Math.hypot(c, d) || Math.hypot(a, b));
  const width = Math.max(0.5, Math.abs(raw.width));
  return {
    text: item.str,
    sourceIndex,
    fragment: {
      page: pageNumber,
      left: clampUnit(x / viewport.width),
      top: clampUnit((baseline - fontHeight) / viewport.height),
      width: clampUnit(width / viewport.width),
      height: clampUnit(fontHeight / viewport.height),
    },
  };
}

interface PdfCanvasProps {
  page: PDFPageProxy;
  availableWidth: number;
  label: string;
  activeFragments?: PdfPaperBlock["fragments"];
  onTextSelection?: (page: number, sourceIndexes: number[]) => void;
  errorLabel: string;
}

function PdfCanvas({ page, availableWidth, label, activeFragments, onTextSelection, errorLabel }: PdfCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderGenerationRef = useRef(0);
  const [renderFailed, setRenderFailed] = useState(false);

  useEffect(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    const textContainer = textLayerRef.current;
    if (!surface || !canvas || !textContainer || availableWidth <= 0) return;
    const generation = renderGenerationRef.current + 1;
    renderGenerationRef.current = generation;
    setRenderFailed(false);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.25, Math.max(0.25, availableWidth / base.width));
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    surface.style.width = `${Math.floor(viewport.width)}px`;
    surface.style.height = `${Math.floor(viewport.height)}px`;
    textContainer.replaceChildren();
    canvas.width = 0;
    canvas.height = 0;
    if (!fitsCanvasLimit(viewport.width, viewport.height, outputScale)) {
      setRenderFailed(true);
      return;
    }
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      setRenderFailed(true);
      return;
    }
    surface.style.setProperty("--total-scale-factor", String(scale));
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
    const releasePage = acquirePageLease(page);
    let active = true;
    let renderTask: ReturnType<PDFPageProxy["render"]>;
    try {
      renderTask = page.render({ canvas, canvasContext: context, viewport, transform });
    } catch {
      releasePage();
      setRenderFailed(true);
      return;
    }
    let textLayer: TextLayer | undefined;
    let sourceItems: unknown[] = [];
    const textPromise = page.getTextContent({ includeMarkedContent: false, disableNormalization: false }).then((content) => {
      if (!active) return;
      sourceItems = content.items;
      textLayer = new TextLayer({ textContentSource: content, container: textContainer, viewport });
      return textLayer.render();
    }).then(() => {
      if (!active || !textLayer) return;
      let sourceCursor = 0;
      textLayer.textDivs.forEach((element, textIndex) => {
        const expectedText = textLayer!.textContentItemsStr[textIndex] ?? "";
        while (sourceCursor < sourceItems.length) {
          const item = sourceItems[sourceCursor];
          const sourceIndex = sourceCursor;
          sourceCursor += 1;
          if (isTextItem(item) && item.str === expectedText) {
            element.dataset.pdfItemIndex = String(sourceIndex);
            break;
          }
        }
      });
    }).catch(() => {
      // A missing text layer must not replace an otherwise readable Canvas page.
      if (active) textContainer.replaceChildren();
    });
    void renderTask.promise.catch((reason: unknown) => {
      if (active && (reason as { name?: string })?.name !== "RenderingCancelledException") setRenderFailed(true);
    });
    void renderTask.promise.then(() => {
      if (active) setRenderFailed(false);
    });
    return () => {
      active = false;
      textLayer?.cancel();
      renderTask.cancel();
      void Promise.allSettled([renderTask.promise, textPromise]).then(() => {
        if (renderGenerationRef.current === generation) {
          textContainer.replaceChildren();
          canvas.width = 0;
          canvas.height = 0;
        }
        releasePage();
      });
    };
  }, [availableWidth, page]);

  const handleSelection = () => {
    const selection = window.getSelection();
    const container = textLayerRef.current;
    if (!selection || selection.isCollapsed || !container || !onTextSelection) return;
    const indexes = new Set<number>();
    for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
      const range = selection.getRangeAt(rangeIndex);
      for (const span of container.querySelectorAll<HTMLElement>("[data-pdf-item-index]")) {
        if (range.intersectsNode(span)) indexes.add(Number(span.dataset.pdfItemIndex));
      }
    }
    if (indexes.size > 0) onTextSelection(page.pageNumber, [...indexes]);
  };

  return (
    <div ref={surfaceRef} className="pdf-page-surface" onPointerUp={handleSelection}>
      <canvas ref={canvasRef} aria-label={label} />
      <div ref={textLayerRef} className="textLayer" />
      {renderFailed && <p className="pdf-page-error" role="alert">{errorLabel}</p>}
      {activeFragments?.filter((fragment) => fragment.page === page.pageNumber).map((fragment, index) => (
        <span
          className="pdf-source-highlight"
          key={`${fragment.page}-${index}`}
          style={{ left: `${fragment.left * 100}%`, top: `${fragment.top * 100}%`, width: `${fragment.width * 100}%`, height: `${fragment.height * 100}%` }}
        />
      ))}
    </div>
  );
}

interface PdfPagePreviewProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  label: string;
  errorLabel: string;
}

function PdfPagePreview({ pdf, pageNumber, label, errorLabel }: PdfPagePreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    }, { rootMargin: "600px 0px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    let renderTask: ReturnType<PDFPageProxy["render"]> | undefined;
    let releasePage: (() => void) | undefined;
    setFailed(false);
    void pdf.getPage(pageNumber).then((nextPage) => {
      if (!active) return;
      releasePage = acquirePageLease(nextPage);
      const base = nextPage.getViewport({ scale: 1 });
      const viewport = nextPage.getViewport({ scale: Math.min(1, 320 / base.width) });
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas is unavailable.");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      try {
        renderTask = nextPage.render({ canvas, canvasContext: context, viewport });
      } catch (error) {
        releasePage();
        releasePage = undefined;
        throw error;
      }
      return renderTask.promise;
    }).catch((reason: unknown) => {
      if (active && (reason as { name?: string })?.name !== "RenderingCancelledException") setFailed(true);
    });
    return () => {
      active = false;
      renderTask?.cancel();
      void renderTask?.promise.catch(() => undefined).finally(() => releasePage?.());
      if (!renderTask) releasePage?.();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [pageNumber, pdf, visible]);

  return <div ref={hostRef} className="pdf-paper-page-preview-host">{visible && (failed ? <span className="pdf-preview-error">{errorLabel}</span> : <canvas ref={canvasRef} className="pdf-paper-page-preview" aria-label={label} />)}</div>;
}

interface PdfPageSlotProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  availableWidth: number;
  pageTop: number;
  pageHeight: number;
  t: PdfReaderProps["t"];
  activeFragments?: PdfPaperBlock["fragments"];
  onTextSelection?: (page: number, sourceIndexes: number[]) => void;
}

function PdfPageSlot({
  pdf, pageNumber, availableWidth, pageTop, pageHeight, t, activeFragments, onTextSelection,
}: PdfPageSlotProps) {
  const [page, setPage] = useState<PDFPageProxy>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setPage(undefined);
    setFailed(false);
    void pdf.getPage(pageNumber).then((nextPage) => {
      if (active) setPage(nextPage);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [pageNumber, pdf]);

  return (
    <div className="continuous-pdf-page" data-page={pageNumber} style={{ top: pageTop, height: pageHeight }}>
      {page && (
        <PdfCanvas
          key={`${page.pageNumber}-${Math.round(availableWidth)}`}
          page={page}
          availableWidth={availableWidth}
          label={t("pdfPage", { page: pageNumber, total: pdf.numPages })}
          activeFragments={activeFragments}
          onTextSelection={onTextSelection}
          errorLabel={t("pdfRenderFailed")}
        />
      )}
      {failed && <p className="pdf-page-slot-error" role="alert">{t("pdfRenderFailed")}</p>}
    </div>
  );
}

export function PdfReader({
  readingProfile, file, locator, preferences, onProgress, onOutline, onCapabilities,
  onCurrentTarget, navigationRef, t,
}: PdfReaderProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const wheelGestureRef = useRef(new WheelGesture());
  const pendingSingleScrollRef = useRef<"start" | "end">("start");
  const initialLocationRef = useRef(parsePdfLocation(locator?.type === "pdf" ? locator.value : undefined));
  const currentLocationRef = useRef(initialLocationRef.current);
  const restoringRef = useRef(readingProfile === "article");
  const pendingPaperPageRef = useRef<number | undefined>(undefined);
  const analysisAbortRef = useRef<AbortController | undefined>(undefined);
  const searchPageCacheRef = useRef(new Map<number, { items: PdfSearchTextItem[]; truncated: boolean; characterLimit: boolean }>());
  const searchFragmentsRef = useRef(new Map<string, PdfPaperBlock["fragments"]>());
  const pendingPaperModeRef = useRef<"article" | "proof" | undefined>(undefined);
  const [viewMode, setViewMode] = useState<"pdf" | "paper">("pdf");
  const [paperDisplayMode, setPaperDisplayMode] = useState<"article" | "proof">("article");
  const [activeBlockId, setActiveBlockId] = useState<string>();
  const [searchFragments, setSearchFragments] = useState<PdfPaperBlock["fragments"]>();
  const [analysis, setAnalysis] = useState<PdfAnalysisState>({ status: "idle", completedPages: 0, totalPages: 0 });
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [pageNumber, setPageNumber] = useState(initialLocationRef.current.page);
  const [pageCount, setPageCount] = useState(0);
  const [hasOutline, setHasOutline] = useState(false);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const [pageAspectRatios, setPageAspectRatios] = useState<number[]>([]);
  const [singlePage, setSinglePage] = useState<PDFPageProxy>();
  const [singlePageFailed, setSinglePageFailed] = useState(false);
  const [fatalError, setFatalError] = useState<TranslationKey>();
  const continuous = readingProfile === "article";
  const showingPaper = viewMode === "paper";
  const continuousCanvas = continuous && !showingPaper;
  const availableWidth = Math.min(1100, Math.max(220, stageWidth - (continuousCanvas ? 48 : 124)));
  const pageLayout = useMemo(() => buildPdfPageLayout(pageAspectRatios, availableWidth), [availableWidth, pageAspectRatios]);
  const pageLayoutRef = useRef(pageLayout);
  pageLayoutRef.current = pageLayout;
  const pageAspectRatiosRef = useRef(pageAspectRatios);
  pageAspectRatiosRef.current = pageAspectRatios;
  const measuredPageRatiosRef = useRef(new Set<number>());
  const visiblePages = useMemo(() => pdfWindowForPage(pageNumber, pageCount), [pageCount, pageNumber]);
  const paperBlocksByPage = useMemo(() => {
    const grouped = new Map<number, PdfPaperBlock[]>();
    for (const block of analysis.document?.blocks ?? []) {
      const page = block.fragments[0]?.page;
      if (!page) continue;
      const blocks = grouped.get(page);
      if (blocks) blocks.push(block);
      else grouped.set(page, [block]);
    }
    return grouped;
  }, [analysis.document]);
  const activeFragments = useMemo(
    () => searchFragments ?? analysis.document?.blocks.find((block) => block.id === activeBlockId)?.fragments,
    [activeBlockId, analysis.document, searchFragments],
  );

  const setStage = useCallback((node: HTMLDivElement | null) => {
    stageRef.current = node;
    setStageElement(node);
  }, []);

  useEffect(() => {
    const stage = stageElement;
    if (!stage) return;
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const width = stage.clientWidth;
        const layout = pageLayoutRef.current;
        if (continuousCanvas && layout.heights.length > 0 && !restoringRef.current) {
          currentLocationRef.current = locatePdfPosition(layout, stage.scrollTop + 24);
          restoringRef.current = true;
        }
        setStageWidth((current) => current === width ? current : width);
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [continuousCanvas, stageElement]);

  useEffect(() => {
    let active = true;
    let task: ReturnType<typeof getDocument> | undefined;
    const searchPageCache = searchPageCacheRef.current;
    const searchFragmentsByResult = searchFragmentsRef.current;
    measuredPageRatiosRef.current.clear();
    setFatalError(undefined);
    void file.arrayBuffer().then((data) => {
      if (!active) return;
      task = getDocument({
        data,
        useWorkerFetch: false,
        maxImageSize: MAX_PDF_CANVAS_PIXELS,
        canvasMaxAreaInBytes: MAX_PDF_CANVAS_PIXELS * 4,
      });
      return task.promise;
    }).then(async (pdf) => {
      if (!active || !pdf) return;
      documentRef.current = pdf;
      setPdfDocument(pdf);
      setPageCount(pdf.numPages);
      setPageAspectRatios(Array.from({ length: pdf.numPages }, () => 1 / 1.414));
      setPageNumber((current) => Math.min(current, pdf.numPages));
      let outline: ReaderOutlineItem[] = [];
      try {
        outline = await getPdfOutline(pdf);
      } catch {
        outline = [];
      }
      if (!active) return;
      onOutline(outline);
      setHasOutline(outline.length > 0);
    }).catch(() => {
      if (active) setFatalError("pdfOpenFailed");
    });
    return () => {
      active = false;
      documentRef.current = null;
      setPdfDocument(undefined);
      setPageCount(0);
      setPageAspectRatios([]);
      setHasOutline(false);
      onOutline([]);
      searchPageCache.clear();
      searchFragmentsByResult.clear();
      onCapabilities({ typography: false, outline: false, publisherFont: false, readingProfile: false, paginated: false, search: false });
      void task?.destroy();
    };
  }, [file, onCapabilities, onOutline]);

  useEffect(() => {
    onCapabilities({ typography: false, outline: hasOutline, publisherFont: false, readingProfile: pageCount > 0, paginated: !continuous, search: pageCount > 0 });
  }, [continuous, hasOutline, onCapabilities, pageCount]);

  useEffect(() => {
    const pdf = pdfDocument;
    if (!pdf || !continuous) return;
    let active = true;
    const ratios = [...pageAspectRatiosRef.current];
    void (async () => {
      for (let start = 1; start <= pdf.numPages; start += 16) {
        const end = Math.min(pdf.numPages, start + 15);
        for (let pageIndex = start; pageIndex <= end; pageIndex += 1) {
          if (!active) return;
          if (measuredPageRatiosRef.current.has(pageIndex)) continue;
          try {
            const page = await pdf.getPage(pageIndex);
            const releasePage = acquirePageLease(page);
            try {
              const viewport = page.getViewport({ scale: 1 });
              ratios[pageIndex - 1] = viewport.width / viewport.height;
              measuredPageRatiosRef.current.add(pageIndex);
            } finally {
              releasePage();
            }
          } catch {
            // Keep the conservative default ratio for a page that cannot be measured.
          }
        }
        if (!active) return;
        setPageAspectRatios([...ratios]);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    })().catch(() => undefined);
    return () => { active = false; };
  }, [continuous, pdfDocument]);

  useEffect(() => {
    const pdf = documentRef.current;
    if (!pdf || continuousCanvas || showingPaper || pageCount === 0) {
      setSinglePage(undefined);
      return;
    }
    let active = true;
    setSinglePage(undefined);
    setSinglePageFailed(false);
    void pdf.getPage(pageNumber).then((page) => {
      if (active) setSinglePage(page);
    }).catch(() => {
      if (active) {
        setSinglePage(undefined);
        setSinglePageFailed(true);
      }
    });
    return () => { active = false; };
  }, [continuousCanvas, pageCount, pageNumber, showingPaper]);

  useEffect(() => {
    if (continuousCanvas || showingPaper || !singlePage || pageCount === 0) return;
    const stage = stageRef.current;
    if (stage) stage.scrollTop = pendingSingleScrollRef.current === "end" ? stage.scrollHeight : 0;
    const target = String(pageNumber);
    onCurrentTarget(target);
    onProgress({
      type: "pdf",
      value: target,
      progression: pageCount <= 1 ? 1 : (pageNumber - 1) / (pageCount - 1),
      label: t("page", { page: pageNumber }),
    });
  }, [continuousCanvas, onCurrentTarget, onProgress, pageCount, pageNumber, showingPaper, singlePage, t]);

  const saveContinuousPosition = useCallback((stageOverride?: HTMLDivElement) => {
    const stage = stageOverride ?? stageRef.current;
    if (!stage || !continuousCanvas || restoringRef.current || pageCount === 0 || pageLayout.heights.length === 0) return;
    const location = locatePdfPosition(pageLayout, stage.scrollTop + 24);
    currentLocationRef.current = location;
    const { page, offset } = location;
    const progression = pageCount <= 1 ? offset : Math.min(1, ((page - 1) + offset) / pageCount);
    setPageNumber(page);
    onCurrentTarget(String(page));
    onProgress({
      type: "pdf",
      value: serializePdfLocation(page, offset),
      progression,
      label: t("page", { page }),
    });
  }, [continuousCanvas, onCurrentTarget, onProgress, pageCount, pageLayout, t]);

  useEffect(() => {
    const stage = stageElement;
    if (!stage || !continuousCanvas || !pdfDocument || pageCount === 0 || pageLayout.heights.length === 0) return;
    let frame = 0;
    let timer = 0;
    const save = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      frame = window.requestAnimationFrame(() => {
        const nextLocation = locatePdfPosition(pageLayout, stage.scrollTop + 24);
        currentLocationRef.current = nextLocation;
        setPageNumber((current) => current === nextLocation.page ? current : nextLocation.page);
        timer = window.setTimeout(saveContinuousPosition, 180);
      });
    };
    stage.addEventListener("scroll", save, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      stage.removeEventListener("scroll", save);
      saveContinuousPosition(stage);
    };
  }, [continuousCanvas, pageCount, pageLayout, pdfDocument, saveContinuousPosition, stageElement]);

  useLayoutEffect(() => {
    const stage = stageElement;
    if (!stage || !continuousCanvas || !pdfDocument || pageLayout.heights.length === 0) return;
    stage.scrollTop = scrollTopForPdfLocation(pageLayout, currentLocationRef.current);
    restoringRef.current = false;
    saveContinuousPosition(stage);
  }, [continuousCanvas, pageLayout, pdfDocument, saveContinuousPosition, stageElement]);

  useEffect(() => {
    const stage = stageElement;
    if (!stage || continuousCanvas || showingPaper) return;
    const gesture = wheelGestureRef.current;
    const handleWheel = (event: WheelEvent) => {
      if (shouldIgnoreWheel(event)) return;
      const delta = normalizedWheelDelta(event, stage.clientHeight);
      if (!delta) return;
      const atStart = stage.scrollTop <= 1;
      const atEnd = stage.scrollHeight - stage.clientHeight - stage.scrollTop <= 2;
      const direction = gesture.push(delta, event.timeStamp, (delta < 0 && atStart) || (delta > 0 && atEnd));
      if (!direction) return;
      if (!((direction === "previous" && atStart) || (direction === "next" && atEnd))) return;
      event.preventDefault();
      if (direction === "previous") {
        pendingSingleScrollRef.current = "end";
        setPageNumber((page) => Math.max(1, page - 1));
      } else {
        pendingSingleScrollRef.current = "start";
        setPageNumber((page) => Math.min(pageCount || page, page + 1));
      }
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", handleWheel);
      gesture.reset();
    };
  }, [continuousCanvas, pageCount, showingPaper, stageElement]);

  const searchPdf = useCallback(async (query: string, options: Parameters<NonNullable<ReaderController["search"]>>[1]) => {
    const pdf = documentRef.current;
    if (!pdf) return { results: [], truncated: false };
    searchFragmentsRef.current.clear();
    setSearchFragments(undefined);
    const results = [];
    const pageLimit = Math.min(pdf.numPages, MAX_PDF_SEARCH_PAGES);
    let characterCount = 0;
    let truncated = pdf.numPages > pageLimit;
    for (let pageIndex = 1; pageIndex <= pageLimit; pageIndex += 1) {
      throwIfSearchAborted(options.signal);
      const cachedPage = searchPageCacheRef.current.get(pageIndex);
      let items = cachedPage?.items;
      let pageReachedCharacterLimit = cachedPage?.characterLimit ?? false;
      if (cachedPage?.truncated) truncated = true;
      if (!items) {
        try {
          const page = await pdf.getPage(pageIndex);
          const releasePage = acquirePageLease(page);
          try {
            const viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
            throwIfSearchAborted(options.signal);
            items = [];
            let pageCharacters = 0;
            let pageTruncated = content.items.length > MAX_PDF_SEARCH_ITEMS_PER_PAGE;
            const remainingCharacters = Math.max(0, MAX_PDF_SEARCH_CHARACTERS - characterCount);
            for (let sourceIndex = 0; sourceIndex < Math.min(content.items.length, MAX_PDF_SEARCH_ITEMS_PER_PAGE); sourceIndex += 1) {
              if (sourceIndex % 256 === 0) throwIfSearchAborted(options.signal);
              const item = content.items[sourceIndex];
              if (!isTextItem(item)) continue;
              if (pageCharacters + item.str.length > remainingCharacters) {
                pageTruncated = true;
                pageReachedCharacterLimit = true;
                const allowed = remainingCharacters - pageCharacters;
                if (allowed > 0) {
                  const searchable = toPdfSearchTextItem({ ...item, str: item.str.slice(0, allowed) }, sourceIndex, pageIndex, viewport);
                  if (searchable) items.push(searchable);
                }
                break;
              }
              const searchable = toPdfSearchTextItem(item, sourceIndex, pageIndex, viewport);
              if (searchable) {
                items.push(searchable);
                pageCharacters += item.str.length;
              }
            }
            if (pageTruncated) truncated = true;
            searchPageCacheRef.current.set(pageIndex, { items, truncated: pageTruncated, characterLimit: pageReachedCharacterLimit });
          } finally {
            releasePage();
          }
        } catch (error) {
          if ((error as { name?: string })?.name === "AbortError") throw error;
          items = [];
        }
      }
      throwIfSearchAborted(options.signal);
      const remaining = Math.max(1, options.maxResults - results.length);
      const pageOutcome = searchPdfTextItems(items, query, {
        page: pageIndex,
        label: t("page", { page: pageIndex }),
        maxResults: remaining,
      });
      characterCount += pageOutcome.characterCount;
      for (const result of pageOutcome.results) {
        if (results.length >= options.maxResults) {
          truncated = true;
          break;
        }
        searchFragmentsRef.current.set(result.id, result.fragments);
        results.push(result);
      }
      if (pageOutcome.truncated || results.length >= options.maxResults) {
        truncated = true;
        break;
      }
      if (pageReachedCharacterLimit) {
        truncated = true;
        break;
      }
      if (characterCount >= MAX_PDF_SEARCH_CHARACTERS) {
        truncated = pageIndex < pdf.numPages;
        break;
      }
      options.onProgress?.(pageIndex / pageLimit);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    throwIfSearchAborted(options.signal);
    options.onProgress?.(1);
    return { results, truncated };
  }, [t]);

  const goToPdfSearchResult = useCallback((result: Parameters<NonNullable<ReaderController["goToSearch"]>>[0]) => {
    const page = Number(result.target.split(":", 1)[0]);
    if (!Number.isInteger(page)) return;
    const safePage = Math.max(1, Math.min(pageCount || page, page));
    const fragments = searchFragmentsRef.current.get(result.id);
    setSearchFragments(fragments);
    setActiveBlockId(undefined);
    pendingPaperModeRef.current = undefined;
    setViewMode("pdf");
    pendingSingleScrollRef.current = "start";
    setPageNumber(safePage);
    currentLocationRef.current = { page: safePage, offset: fragments?.[0]?.top ?? 0 };
    if (continuous) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        stageRef.current?.scrollTo({ top: pageLayout.offsets[safePage - 1] ?? 0, behavior: "smooth" });
      }));
    }
  }, [continuous, pageCount, pageLayout.offsets]);

  useEffect(() => {
    navigationRef.current = {
      previous: () => {
        if (showingPaper || continuousCanvas) stageRef.current?.scrollBy({ top: -(stageRef.current.clientHeight * 0.86), behavior: "smooth" });
        else {
          pendingSingleScrollRef.current = "end";
          setPageNumber((page) => Math.max(1, page - 1));
        }
      },
      next: () => {
        if (showingPaper || continuousCanvas) stageRef.current?.scrollBy({ top: stageRef.current.clientHeight * 0.86, behavior: "smooth" });
        else {
          pendingSingleScrollRef.current = "start";
          setPageNumber((page) => Math.min(pageCount || page, page + 1));
        }
      },
      goTo: (target) => {
        setSearchFragments(undefined);
        const page = Number(target.split(":", 1)[0]);
        if (!Number.isInteger(page)) return;
        const safePage = Math.max(1, Math.min(pageCount || page, page));
        if (showingPaper) {
          document.querySelector<HTMLElement>(`[data-paper-page="${safePage}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (continuousCanvas) {
          stageRef.current?.scrollTo({ top: pageLayout.offsets[safePage - 1] ?? 0, behavior: "smooth" });
        } else {
          pendingSingleScrollRef.current = "start";
          setPageNumber(safePage);
        }
      },
      search: searchPdf,
      goToSearch: goToPdfSearchResult,
      clearSearch: () => {
        searchFragmentsRef.current.clear();
        setSearchFragments(undefined);
      },
    };
    return () => { navigationRef.current = null; };
  }, [continuousCanvas, goToPdfSearchResult, navigationRef, pageCount, pageLayout, searchPdf, showingPaper]);

  const startAnalysis = useCallback(async () => {
    if (analysis.status === "running" || pageCount === 0) return;
    if (pageCount > MAX_PDF_ANALYSIS_PAGES) {
      setAnalysis({ status: "failed", completedPages: 0, totalPages: pageCount });
      return;
    }
    const controller = new AbortController();
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = controller;
    setAnalysis({ status: "running", completedPages: 0, totalPages: pageCount });
    const pages = [];
    let characterCount = 0;
    try {
      const pdf = documentRef.current;
      if (!pdf) throw new Error("PDF document is not ready.");
      for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
        if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const page = await pdf.getPage(pageIndex);
        const releasePage = acquirePageLease(page);
        try {
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
          const analyzed = analyzePdfTextPage({
            page: pageIndex,
            width: viewport.width,
            height: viewport.height,
            items: content.items.flatMap((item, sourceIndex) => isTextItem(item) ? [toRawTextItem(item, sourceIndex, viewport)] : []),
          });
          characterCount += analyzed.characterCount;
          if (characterCount > MAX_PDF_ANALYSIS_CHARACTERS) throw new RangeError("PDF analysis character limit exceeded");
          pages.push(analyzed);
        } finally {
          releasePage();
        }
        setAnalysis({ status: "running", completedPages: pageIndex, totalPages: pdf.numPages });
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      if (controller.signal.aborted) return;
      const document = buildPdfPaperDocument(pages);
      setAnalysis({ status: "ready", completedPages: pdf.numPages, totalPages: pdf.numPages, document });
    } catch (reason) {
      if ((reason as { name?: string })?.name === "AbortError") {
        setAnalysis((current) => ({ ...current, status: "cancelled", document: undefined }));
      } else setAnalysis((current) => ({ ...current, status: "failed", document: undefined }));
    } finally {
      analysisAbortRef.current = undefined;
    }
  }, [analysis.status, pageCount]);

  useEffect(() => () => {
    analysisAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = undefined;
    pendingPaperModeRef.current = undefined;
    setViewMode("pdf");
    setAnalysis({ status: "idle", completedPages: 0, totalPages: 0 });
  }, [file]);

  useEffect(() => {
    if (!pendingPaperModeRef.current || pageCount === 0 || analysis.status !== "idle") return;
    void startAnalysis();
  }, [analysis.status, pageCount, startAnalysis]);

  useEffect(() => {
    if (analysis.status !== "ready" || !pendingPaperModeRef.current) return;
    const mode = pendingPaperModeRef.current;
    pendingPaperModeRef.current = undefined;
    setPaperDisplayMode(mode);
    pendingPaperPageRef.current = currentLocationRef.current.page;
    setViewMode("paper");
  }, [analysis.status]);

  useLayoutEffect(() => {
    if (!showingPaper) return;
    const page = pendingPaperPageRef.current ?? currentLocationRef.current.page;
    pendingPaperPageRef.current = undefined;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-paper-page="${page}"]`)?.scrollIntoView({ block: "start" }));
  }, [showingPaper]);

  useEffect(() => {
    const stage = stageElement;
    const paper = analysis.document;
    if (!stage || !showingPaper || !paper) return;
    let frame = 0;
    let timer = 0;
    const locate = () => {
      const marker = stage.getBoundingClientRect().top + 78;
      const anchors = [...stage.querySelectorAll<HTMLElement>("[data-paper-page]")];
      let anchor = anchors[0];
      for (const candidate of anchors) {
        if (candidate.getBoundingClientRect().top <= marker) anchor = candidate;
        else break;
      }
      if (!anchor) return;
      const page = Number(anchor.dataset.paperPage);
      if (!Number.isInteger(page)) return;
      const pageElement = anchor.closest<HTMLElement>(".pdf-paper-page-content") ?? anchor;
      const rect = pageElement.getBoundingClientRect();
      const offset = Math.max(0, Math.min(1, (marker - rect.top) / Math.max(1, rect.height)));
      currentLocationRef.current = { page, offset };
      setPageNumber((current) => current === page ? current : page);
      onCurrentTarget(String(page));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const progression = pageCount <= 1 ? offset : Math.min(1, ((page - 1) + offset) / pageCount);
        onProgress({ type: "pdf", value: serializePdfLocation(page, offset), progression, label: t("page", { page }) });
      }, 180);
    };
    const handleScroll = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(locate);
    };
    stage.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      stage.removeEventListener("scroll", handleScroll);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      const { page, offset } = currentLocationRef.current;
      const progression = pageCount <= 1 ? offset : Math.min(1, ((page - 1) + offset) / pageCount);
      onProgress({ type: "pdf", value: serializePdfLocation(page, offset), progression, label: t("page", { page }) });
    };
  }, [analysis.document, onCurrentTarget, onProgress, pageCount, showingPaper, stageElement, t]);

  const selectBlock = useCallback((block: PdfPaperBlock, preferredPage?: number) => {
    setActiveBlockId(block.id);
    const fragment = block.fragments.find((candidate) => candidate.page === preferredPage) ?? block.fragments[0];
    const page = fragment?.page;
    if (page) {
      const offset = fragment?.top ?? 0;
      currentLocationRef.current = { page, offset };
      setPageNumber(page);
      onCurrentTarget(String(page));
      const progression = pageCount <= 1 ? offset : Math.min(1, ((page - 1) + offset) / pageCount);
      onProgress({ type: "pdf", value: serializePdfLocation(page, offset), progression, label: t("page", { page }) });
    }
  }, [onCurrentTarget, onProgress, pageCount, t]);

  const selectSourceItems = useCallback((page: number, sourceIndexes: number[]) => {
    const selected = new Set(sourceIndexes);
    const matches = analysis.document?.blocks.filter((candidate) => candidate.sourceItems.some((item) => item.page === page && selected.has(item.index))) ?? [];
    if (matches.length === 1) selectBlock(matches[0]!, page);
    else setActiveBlockId(undefined);
  }, [analysis.document, selectBlock]);

  const handlePaperSelection = useCallback((block: PdfPaperBlock) => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) setActiveBlockId(block.id);
  }, []);

  const changeView = useCallback((next: "pdf" | "paper") => {
    if (next === viewMode) return;
    if (next === "paper" && analysis.status !== "ready") {
      void startAnalysis();
      return;
    }
    if (next === "pdf") {
      restoringRef.current = continuous;
      setPageNumber(currentLocationRef.current.page);
    } else pendingPaperPageRef.current = currentLocationRef.current.page;
    setViewMode(next);
  }, [analysis.status, continuous, startAnalysis, viewMode]);

  const openPaperMode = useCallback((mode: "article" | "proof") => {
    setPaperDisplayMode(mode);
    if (analysis.status !== "ready") {
      pendingPaperModeRef.current = mode;
      void startAnalysis();
      return;
    }
    changeView("paper");
  }, [analysis.status, changeView, startAnalysis]);

  const renderPaperBlock = (block: PdfPaperBlock, page: number) => (
    <div
      className={`pdf-paper-row pdf-source-only-row ${activeBlockId === block.id ? "active" : ""}`}
      data-block-id={block.id}
      key={`${page}-${block.id}`}
      role="button"
      tabIndex={0}
      aria-pressed={activeBlockId === block.id}
      aria-label={t("showPdfSource", { text: block.text.slice(0, 80) })}
      onClick={() => selectBlock(block, page)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectBlock(block, page);
      }}
      onPointerUp={() => handlePaperSelection(block)}
    >
      <div className={`pdf-paper-source pdf-block-${block.kind}`}>
        <span className="pdf-block-kind">{t(`pdfBlock_${block.kind}` as TranslationKey)}</span>
        <span>{block.text}</span>
      </div>
    </div>
  );

  if (fatalError) return <p className="reader-error">{t(fatalError)}</p>;

  return (
    <div className={`reader-stage pdf-stage ${continuousCanvas ? "pdf-continuous" : "pdf-paginated"} ${showingPaper ? "pdf-paper-stage" : ""} theme-${preferences.theme}`} ref={setStage}>
      <div className="pdf-view-toolbar" role="toolbar" aria-label={t("pdfViewMode")}>
        <div className="pdf-view-switch" role="group" aria-label={t("pdfViewMode")}>
          <button type="button" className={!showingPaper ? "active" : ""} aria-pressed={!showingPaper} onClick={() => { pendingPaperModeRef.current = undefined; changeView("pdf"); }}>
            <FileText />{t("originalPdf")}
          </button>
          <button type="button" className={showingPaper && paperDisplayMode === "article" ? "active" : ""} aria-pressed={showingPaper && paperDisplayMode === "article"} onClick={() => openPaperMode("article")}>
            {analysis.status === "running" && pendingPaperModeRef.current === "article" ? <LoaderCircle className="spin" /> : <Rows3 />}{t("reflowedArticle")}
          </button>
          <button type="button" className={showingPaper && paperDisplayMode === "proof" ? "active" : ""} aria-pressed={showingPaper && paperDisplayMode === "proof"} onClick={() => openPaperMode("proof")}>
            {analysis.status === "running" && pendingPaperModeRef.current === "proof" ? <LoaderCircle className="spin" /> : <Columns2 />}{t("proofreadLayout")}
          </button>
        </div>
        {analysis.status === "running" && <span>{t("pdfAnalysisProgress", { current: analysis.completedPages, total: analysis.totalPages })}</span>}
        {analysis.status === "failed" && <span className="pdf-analysis-error">{t("pdfAnalysisFailed")}</span>}
      </div>
      {showingPaper && analysis.document ? (
        <article className={`pdf-paper-document mode-${paperDisplayMode}`}>
          <div className="pdf-paper-summary" aria-label={t("reflowSummary")}>
            <div><strong>{analysis.document.pages.length}</strong><span>{t("pdfPages")}</span></div>
            <div><strong>{analysis.document.blocks.length}</strong><span>{t("pdfBlocks")}</span></div>
            <div><strong>{analysis.document.characterCount.toLocaleString()}</strong><span>{t("pdfCharacters")}</span></div>
            <div><strong>{analysis.document.reviewPages.length + analysis.document.rejectedPages.length}</strong><span>{t("pagesNeedingReview")}</span></div>
          </div>
          {(analysis.document.reviewPages.length > 0 || analysis.document.rejectedPages.length > 0) && (
            <p className="pdf-paper-warning">{t("reflowReviewWarning", {
              review: analysis.document.reviewPages.length,
              rejected: analysis.document.rejectedPages.length,
            })}</p>
          )}
          <div className="pdf-reflow-pages">
            {analysis.document.pages.map((page) => {
              const blocks = paperBlocksByPage.get(page.page) ?? [];
              return (
                <section className={`pdf-reflow-page quality-${page.quality}`} key={page.page}>
                  <div className="pdf-paper-page-marker" data-paper-page={page.page}>
                    <span>{t("page", { page: page.page })}</span>
                    {page.quality !== "supported" && <strong>{t(page.quality === "rejected" ? "pdfPageRejected" : "pdfPageReview")}</strong>}
                  </div>
                  {paperDisplayMode === "proof" ? (
                    <div className="pdf-proof-row">
                      <div className="pdf-proof-preview">
                        {pdfDocument && <PdfPagePreview pdf={pdfDocument} pageNumber={page.page} label={t("pdfPageVisual", { page: page.page })} errorLabel={t("pdfRenderFailed")} />}
                      </div>
                      <div className="pdf-proof-text">
                        {blocks.length > 0 ? blocks.map((block) => renderPaperBlock(block, page.page)) : (
                          <p className="pdf-paper-empty-page">{t(page.quality === "rejected" ? "pdfVisualFallback" : "pdfPageEmpty")}</p>
                        )}
                      </div>
                    </div>
                  ) : blocks.length > 0 ? blocks.map((block) => renderPaperBlock(block, page.page)) : (
                    <p className="pdf-paper-empty-page">{t(page.quality === "rejected" ? "pdfVisualFallback" : "pdfPageEmpty")}</p>
                  )}
                </section>
              );
            })}
          </div>
        </article>
      ) : continuousCanvas && pdfDocument ? (
        <div className="continuous-pdf-track" style={{ height: pageLayout.totalHeight }}>
          {visiblePages.map((page) => (
            <PdfPageSlot
              key={page}
              pdf={pdfDocument}
              pageNumber={page}
              availableWidth={availableWidth}
              pageTop={pageLayout.offsets[page - 1] ?? 0}
              pageHeight={pageLayout.heights[page - 1] ?? 1}
              t={t}
              activeFragments={activeFragments}
              onTextSelection={selectSourceItems}
            />
          ))}
        </div>
      ) : singlePage && (
        <PdfCanvas
          key={`${singlePage.pageNumber}-${Math.round(availableWidth)}`}
          page={singlePage}
          availableWidth={availableWidth}
          label={t("pdfPage", { page: pageNumber, total: pageCount || "..." })}
          activeFragments={activeFragments}
          onTextSelection={selectSourceItems}
          errorLabel={t("pdfRenderFailed")}
        />
      )}
      {!showingPaper && !continuousCanvas && singlePageFailed && <p className="pdf-page-slot-error" role="alert">{t("pdfRenderFailed")}</p>}
      {!showingPaper && <div className="page-status" aria-live="polite">{pageNumber} / {pageCount || "..."}</div>}
    </div>
  );
}
