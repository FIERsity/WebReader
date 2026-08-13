import { FileText, Languages, LoaderCircle, Pause, Rows3 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  GlobalWorkerOptions, getDocument, TextLayer, type PDFDocumentProxy, type PDFPageProxy,
} from "pdfjs-dist";
import { PdfTranslationDialog } from "../components/PdfTranslationDialog";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import { parsePdfLocation, serializePdfLocation } from "../lib/pdfLocation";
import {
  buildPdfPageLayout, locatePdfPosition, pdfWindowForPage, scrollTopForPdfLocation,
} from "../lib/pdfLayout";
import { getPdfOutline } from "../lib/pdfOutline";
import { fitsCanvasLimit, MAX_PDF_CANVAS_PIXELS } from "../lib/pdfLimits";
import {
  analyzePdfTextPage, buildPdfPaperDocument, MAX_PDF_ANALYSIS_CHARACTERS, MAX_PDF_ANALYSIS_PAGES,
  type PdfPaperBlock, type PdfPaperDocument, type PdfRawTextItem,
} from "../lib/pdfText";
import { WheelGesture, normalizedWheelDelta, shouldIgnoreWheel } from "../lib/wheelPager";
import { hashText } from "../lib/translation";
import {
  createPaperBatches, paperManifestHash, translatePaperBatch, type PaperTranslationError,
} from "../lib/paperTranslation";
import {
  completePaperTranslationBatch, createPaperTranslationJob, listPaperTranslationBatches,
  listPaperTranslationJobs, listPaperTranslationResults, pausePaperTranslationJob,
  resumePaperTranslationJob, updatePaperTranslationBatch, updatePaperTranslationJob,
} from "../lib/storage";
import type { ReaderPreferences, ReadingLocator, ReadingProfile } from "../types/library";
import type {
  PaperTranslationBatch, PaperTranslationJob, PaperTranslationProviderConfig, PaperTranslationResult,
  PaperTranslationUnit, TranslationTargetLanguage,
} from "../types/translation";
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
      page.cleanup();
    } else pageRenderLeases.set(page, remaining);
  };
}

interface PdfReaderProps {
  bookId: string;
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

function paperErrorCode(reason: unknown): PaperTranslationError["code"] {
  const code = (reason as { code?: unknown })?.code;
  return code === "auth" || code === "rate-limit" || code === "cors" || code === "timeout" || code === "transient"
    || code === "invalid-output" || code === "provider" || code === "cancelled" ? code : "provider";
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

interface PdfCanvasProps {
  page: PDFPageProxy;
  availableWidth: number;
  label: string;
  activeFragments?: PdfPaperBlock["fragments"];
  onTextSelection?: (page: number, sourceIndexes: number[]) => void;
  onError: () => void;
}

function PdfCanvas({ page, availableWidth, label, activeFragments, onTextSelection, onError }: PdfCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    const textContainer = textLayerRef.current;
    if (!surface || !canvas || !textContainer || availableWidth <= 0) return;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.25, Math.max(0.25, availableWidth / base.width));
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    if (!fitsCanvasLimit(viewport.width, viewport.height, outputScale)) {
      onError();
      return;
    }
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      onError();
      return;
    }
    surface.style.width = `${Math.floor(viewport.width)}px`;
    surface.style.height = `${Math.floor(viewport.height)}px`;
    surface.style.setProperty("--total-scale-factor", String(scale));
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
    const renderTask = page.render({ canvas, canvasContext: context, viewport, transform });
    const releasePage = acquirePageLease(page);
    let active = true;
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
    }).catch((reason: unknown) => {
      if (active && (reason as { name?: string })?.name !== "AbortException") onError();
    });
    void renderTask.promise.catch((reason: unknown) => {
      if ((reason as { name?: string })?.name !== "RenderingCancelledException") onError();
    });
    return () => {
      active = false;
      textLayer?.cancel();
      renderTask.cancel();
      void Promise.allSettled([renderTask.promise, textPromise]).then(() => {
        textContainer.replaceChildren();
        canvas.width = 0;
        canvas.height = 0;
        releasePage();
      });
    };
  }, [availableWidth, onError, page]);

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
  onError: () => void;
}

function PdfPagePreview({ pdf, pageNumber, label, onError }: PdfPagePreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

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
    void pdf.getPage(pageNumber).then((nextPage) => {
      if (!active) return;
      releasePage = acquirePageLease(nextPage);
      const base = nextPage.getViewport({ scale: 1 });
      const viewport = nextPage.getViewport({ scale: Math.min(1, 320 / base.width) });
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      renderTask = nextPage.render({ canvas, canvasContext: context, viewport });
      return renderTask.promise;
    }).catch((reason: unknown) => {
      if ((reason as { name?: string })?.name !== "RenderingCancelledException") onError();
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
  }, [onError, pageNumber, pdf, visible]);

  return <div ref={hostRef} className="pdf-paper-page-preview-host">{visible && <canvas ref={canvasRef} className="pdf-paper-page-preview" aria-label={label} />}</div>;
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
  onError: () => void;
}

function PdfPageSlot({
  pdf, pageNumber, availableWidth, pageTop, pageHeight, t, activeFragments, onTextSelection, onError,
}: PdfPageSlotProps) {
  const [page, setPage] = useState<PDFPageProxy>();

  useEffect(() => {
    let active = true;
    void pdf.getPage(pageNumber).then((nextPage) => {
      if (active) setPage(nextPage);
    }).catch(onError);
    return () => { active = false; };
  }, [onError, pageNumber, pdf]);

  return (
    <div className="continuous-pdf-page" data-page={pageNumber} style={{ top: pageTop, height: pageHeight }}>
      {page && (
        <PdfCanvas
          page={page}
          availableWidth={availableWidth}
          label={t("pdfPage", { page: pageNumber, total: pdf.numPages })}
          activeFragments={activeFragments}
          onTextSelection={onTextSelection}
          onError={onError}
        />
      )}
    </div>
  );
}

export function PdfReader({
  bookId, readingProfile, file, locator, preferences, onProgress, onOutline, onCapabilities,
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
  const translationAbortRef = useRef<AbortController | undefined>(undefined);
  const providerConfigRef = useRef<PaperTranslationProviderConfig | undefined>(undefined);
  const translationRunRef = useRef<string | undefined>(undefined);
  const translationRequestedRef = useRef(false);
  const [viewMode, setViewMode] = useState<"pdf" | "paper">("pdf");
  const [paperDisplayMode, setPaperDisplayMode] = useState<"paired" | "translation">("paired");
  const [activeBlockId, setActiveBlockId] = useState<string>();
  const [documentRevision, setDocumentRevision] = useState<string>();
  const [translationDialogOpen, setTranslationDialogOpen] = useState(false);
  const [translationJob, setTranslationJob] = useState<PaperTranslationJob>();
  const [translationResults, setTranslationResults] = useState<Map<string, PaperTranslationResult>>(new Map());
  const [translationError, setTranslationError] = useState<string>();
  const [analysis, setAnalysis] = useState<PdfAnalysisState>({ status: "idle", completedPages: 0, totalPages: 0 });
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [pageNumber, setPageNumber] = useState(initialLocationRef.current.page);
  const [pageCount, setPageCount] = useState(0);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const [pageAspectRatios, setPageAspectRatios] = useState<number[]>([]);
  const [singlePage, setSinglePage] = useState<PDFPageProxy>();
  const [error, setError] = useState<TranslationKey>();
  const continuous = readingProfile === "article";
  const showingPaper = viewMode === "paper";
  const continuousCanvas = continuous && !showingPaper;
  const availableWidth = Math.min(1100, Math.max(220, stageWidth - (continuousCanvas ? 48 : 124)));
  const pageLayout = useMemo(() => buildPdfPageLayout(pageAspectRatios, availableWidth), [availableWidth, pageAspectRatios]);
  const pageLayoutRef = useRef(pageLayout);
  pageLayoutRef.current = pageLayout;
  const visiblePages = useMemo(() => pdfWindowForPage(pageNumber, pageCount), [pageCount, pageNumber]);

  const handleRenderError = useCallback(() => setError("pdfRenderFailed"), []);
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
    void file.arrayBuffer().then(async (data) => {
      if (!active) return;
      const digest = await crypto.subtle.digest("SHA-256", data.slice(0));
      if (!active) return;
      const revisionHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      setDocumentRevision(`sha256:${revisionHash}:pdf-text-v2`);
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
      setPageAspectRatios(continuous ? Array.from({ length: pdf.numPages }, () => 1 / 1.414) : []);
      setPageNumber((current) => Math.min(current, pdf.numPages));
      let outline: ReaderOutlineItem[] = [];
      try {
        outline = await getPdfOutline(pdf);
      } catch {
        outline = [];
      }
      if (!active) return;
      onOutline(outline);
      onCapabilities({ typography: false, outline: outline.length > 0, publisherFont: false });
      if (continuous) {
        const ratios = Array.from({ length: pdf.numPages }, () => 1 / 1.414);
        for (let start = 1; start <= pdf.numPages; start += 16) {
          const end = Math.min(pdf.numPages, start + 15);
          for (let pageIndex = start; pageIndex <= end; pageIndex += 1) {
            if (!active) return;
            const page = await pdf.getPage(pageIndex);
            const viewport = page.getViewport({ scale: 1 });
            ratios[pageIndex - 1] = viewport.width / viewport.height;
          }
          if (!active) return;
          setPageAspectRatios((current) => {
            const next = [...current];
            for (let index = start; index <= end; index += 1) next[index - 1] = ratios[index - 1]!;
            return next;
          });
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      }
    }).catch(() => {
      if (active) setError("pdfOpenFailed");
    });
    return () => {
      active = false;
      documentRef.current = null;
      setPdfDocument(undefined);
      setPageAspectRatios([]);
      onOutline([]);
      onCapabilities({ typography: false, outline: false, publisherFont: false });
      void task?.destroy();
    };
  }, [continuous, file, onCapabilities, onOutline]);

  useEffect(() => {
    const pdf = documentRef.current;
    if (!pdf || continuousCanvas || showingPaper || pageCount === 0) {
      setSinglePage(undefined);
      return;
    }
    let active = true;
    void pdf.getPage(pageNumber).then((page) => {
      if (active) setSinglePage(page);
    }).catch(handleRenderError);
    return () => { active = false; };
  }, [continuousCanvas, handleRenderError, pageCount, pageNumber, showingPaper]);

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
    };
    return () => { navigationRef.current = null; };
  }, [continuousCanvas, navigationRef, pageCount, pageLayout, showingPaper]);

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
    translationAbortRef.current?.abort();
    providerConfigRef.current = undefined;
  }, []);

  const paperUnits = useMemo(() => {
    const units: PaperTranslationUnit[] = [];
    let section: string | undefined;
    for (const block of analysis.document?.blocks ?? []) {
      if (block.kind === "title" || block.kind === "heading") section = block.text;
      if (block.kind === "equation" || block.kind === "reference" || !block.text.trim()) continue;
      units.push({ id: block.id, text: block.text, kind: block.kind, section });
    }
    return units;
  }, [analysis.document]);

  useEffect(() => {
    if (!documentRevision || analysis.status !== "ready" || paperUnits.length === 0) return;
    let active = true;
    void paperManifestHash(paperUnits).then(async (manifestHash) => {
      const jobs = await listPaperTranslationJobs(bookId, documentRevision);
      if (!active) return;
      const latest = jobs.filter((job) => job.manifestHash === manifestHash).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!latest) {
        if (translationRequestedRef.current) {
          translationRequestedRef.current = false;
          setTranslationDialogOpen(true);
        }
        return;
      }
      if (translationRequestedRef.current) {
        translationRequestedRef.current = false;
        if (latest.completedUnits < latest.totalUnits) setTranslationDialogOpen(true);
        else {
          setViewMode("paper");
          setPaperDisplayMode("paired");
        }
      }
      setTranslationJob(latest.status === "running" ? { ...latest, status: "paused-needs-key" } : latest);
      if (latest.status === "running") await updatePaperTranslationJob(latest.id, { status: "paused-needs-key" });
      const results = await listPaperTranslationResults(latest.id);
      if (active) setTranslationResults(new Map(results.map((result) => [result.blockId, result])));
    }).catch(() => { if (active) setTranslationError(t("paperTranslationStorageFailed")); });
    return () => { active = false; };
  }, [analysis.status, bookId, documentRevision, paperUnits, t]);

  useEffect(() => {
    if (analysis.status !== "failed" || !translationRequestedRef.current) return;
    translationRequestedRef.current = false;
    setTranslationError(t("pdfAnalysisFailed"));
  }, [analysis.status, t]);

  const runPaperTranslation = useCallback(async (
    config: PaperTranslationProviderConfig,
    targetLanguage: TranslationTargetLanguage,
  ) => {
    const paper = analysis.document;
    if (!paper || !documentRevision || paperUnits.length === 0) return;
    providerConfigRef.current = config;
    translationAbortRef.current?.abort();
    const controller = new AbortController();
    const runId = crypto.randomUUID();
    translationAbortRef.current = controller;
    translationRunRef.current = runId;
    setTranslationError(undefined);
    setTranslationDialogOpen(false);
    setViewMode("paper");
    setPaperDisplayMode("paired");
    let activeJobId: string | undefined;
    let activeBatch: PaperTranslationBatch | undefined;
    try {
      const assertCurrentRun = () => {
        if (controller.signal.aborted || translationRunRef.current !== runId) throw new DOMException("Superseded", "AbortError");
      };
      const manifestHash = await paperManifestHash(paperUnits);
      assertCurrentRun();
      const storedJobs = await listPaperTranslationJobs(bookId, documentRevision);
      assertCurrentRun();
      let job = storedJobs.find((candidate) => candidate.manifestHash === manifestHash
        && candidate.provider === config.provider && candidate.model === config.model
        && candidate.endpoint === config.endpoint && candidate.targetLanguage === targetLanguage
        && candidate.status !== "cancelled");
      let batches: PaperTranslationBatch[];
      if (!job) {
        const definitions = createPaperBatches(paperUnits);
        const now = Date.now();
        job = {
          id: crypto.randomUUID(), bookId, documentRevision, segmenterVersion: paper.algorithmVersion,
          promptVersion: "paper-v1", manifestHash,
          provider: config.provider, model: config.model, endpoint: config.endpoint,
          targetLanguage, status: "queued", totalUnits: paperUnits.length, completedUnits: 0,
          batchCount: definitions.length, completedBatches: 0, createdAt: now, updatedAt: now,
        };
        batches = definitions.map((batch) => ({
          id: crypto.randomUUID(), jobId: job!.id, bookId, ordinal: batch.ordinal,
          unitIds: batch.units.map((unit) => unit.id), status: "queued", attempt: 0, updatedAt: now,
        }));
        if (!await createPaperTranslationJob(job, batches)) throw new Error("Source book was removed.");
        assertCurrentRun();
      } else {
        batches = (await listPaperTranslationBatches(job.id)).map((batch) => batch.status === "running" ? { ...batch, status: "queued" } : batch);
        assertCurrentRun();
      }
      const storedResults = await listPaperTranslationResults(job.id);
      assertCurrentRun();
      activeJobId = job.id;
      const results = new Map(storedResults.map((result) => [result.blockId, result]));
      setTranslationResults(new Map(results));
      job = { ...job, status: "running", lastErrorCode: undefined, updatedAt: Date.now() };
      if (!await resumePaperTranslationJob(job.id)) throw new Error("Translation job was removed.");
      assertCurrentRun();
      setTranslationJob(job);
      const unitsById = new Map(paperUnits.map((unit) => [unit.id, unit]));
      let completedBatches = batches.filter((batch) => batch.status === "completed").length;
      let completedUnits = results.size;
      for (const batch of batches.sort((a, b) => a.ordinal - b.ordinal)) {
        if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const missingUnits = batch.unitIds
          .map((id) => unitsById.get(id))
          .filter((unit): unit is PaperTranslationUnit => unit !== undefined)
          .filter((unit) => !results.has(unit.id));
        if (missingUnits.length === 0) continue;
        activeBatch = batch;
        await updatePaperTranslationBatch(job.id, batch.id, { status: "running", attempt: batch.attempt + 1, errorCode: undefined });
        assertCurrentRun();
        const preceding = [...results.values()].slice(-3).map((result) => result.translatedText).join("\n");
        const section = missingUnits[0]?.section ?? "";
        let translated: Map<string, string> | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            translated = await translatePaperBatch({
              config, targetLanguage, units: missingUnits,
              context: [section && `Current section: ${section}`, preceding && `Previous translated context:\n${preceding}`].filter(Boolean).join("\n\n"),
              signal: controller.signal,
            });
            break;
          } catch (reason) {
            const code = paperErrorCode(reason);
            if (attempt >= 2 || code !== "rate-limit" && code !== "timeout" && code !== "transient") throw reason;
            const requestedDelay = (reason as PaperTranslationError).retryAfterMs ?? 1_000 * 2 ** attempt;
            const delay = Math.min(30_000, Math.max(500, requestedDelay));
            await new Promise<void>((resolve, reject) => {
              const timer = window.setTimeout(resolve, delay);
              controller.signal.addEventListener("abort", () => {
                window.clearTimeout(timer);
                reject(new DOMException("Cancelled", "AbortError"));
              }, { once: true });
            });
          }
        }
        if (!translated) throw new Error("Translation batch did not complete.");
        assertCurrentRun();
        const now = Date.now();
        const records = await Promise.all(missingUnits.map(async (unit) => ({
          key: `${job!.id}:${unit.id}`, jobId: job!.id, bookId, blockId: unit.id,
          sourceHash: await hashText(unit.text), translatedText: translated.get(unit.id)!, createdAt: now, updatedAt: now,
        })));
        assertCurrentRun();
        for (const record of records) results.set(record.blockId, record);
        completedBatches += 1;
        completedUnits = results.size;
        if (!await completePaperTranslationBatch({
          jobId: job.id, batchId: batch.id, results: records, completedUnits, completedBatches,
        })) throw new Error("Translation job was removed.");
        assertCurrentRun();
        job = { ...job, completedUnits, completedBatches, updatedAt: now };
        activeBatch = undefined;
        setTranslationJob(job);
        setTranslationResults(new Map(results));
      }
      job = { ...job, status: "completed", completedUnits, completedBatches, updatedAt: Date.now() };
      await updatePaperTranslationJob(job.id, { status: "completed", completedUnits, completedBatches, lastErrorCode: undefined });
      assertCurrentRun();
      setTranslationJob(job);
    } catch (reason) {
      if (translationRunRef.current !== runId) return;
      const providerReason = reason as PaperTranslationError;
      const cancelled = providerReason.code === "cancelled" || (reason as { name?: string })?.name === "AbortError";
      const status = cancelled ? "paused-needs-key" : "failed";
      const code = paperErrorCode(providerReason);
      setTranslationJob((current) => current ? { ...current, status, lastErrorCode: code } : current);
      if (activeJobId) {
        await pausePaperTranslationJob({
          jobId: activeJobId,
          status,
          errorCode: code,
          activeBatchId: activeBatch?.id,
          batchStatus: activeBatch ? cancelled ? "queued" : "failed" : undefined,
          batchAttempt: activeBatch ? activeBatch.attempt + 1 : undefined,
        });
      }
      if (!cancelled) setTranslationError(t(`paperTranslationError_${code}` as TranslationKey));
    } finally {
      if (translationRunRef.current === runId) {
        translationAbortRef.current = undefined;
        translationRunRef.current = undefined;
        providerConfigRef.current = undefined;
      }
    }
  }, [analysis.document, bookId, documentRevision, paperUnits, t]);

  const requestPaperTranslation = useCallback(() => {
    if (analysis.status !== "ready") {
      translationRequestedRef.current = true;
      void startAnalysis();
      return;
    }
    setTranslationDialogOpen(true);
  }, [analysis.status, startAnalysis]);

  const pausePaperTranslation = useCallback(() => {
    translationAbortRef.current?.abort();
    providerConfigRef.current = undefined;
  }, []);

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

  if (error) return <p className="reader-error">{t(error)}</p>;

  return (
    <div className={`reader-stage pdf-stage ${continuousCanvas ? "pdf-continuous" : "pdf-paginated"} ${showingPaper ? "pdf-paper-stage" : ""} theme-${preferences.theme}`} ref={setStage}>
      <div className="pdf-view-toolbar" role="toolbar" aria-label={t("pdfViewMode")}>
        <div className="pdf-view-switch" role="group" aria-label={t("pdfViewMode")}>
          <button type="button" className={!showingPaper ? "active" : ""} aria-pressed={!showingPaper} onClick={() => changeView("pdf")}>
            <FileText />{t("originalPdf")}
          </button>
          {analysis.status === "ready" && translationJob && (
            <>
              <button type="button" className={showingPaper && paperDisplayMode === "paired" ? "active" : ""} aria-pressed={showingPaper && paperDisplayMode === "paired"} onClick={() => { setPaperDisplayMode("paired"); changeView("paper"); }}>
                <Rows3 />{t("pairedTranslation")}
              </button>
              <button type="button" className={showingPaper && paperDisplayMode === "translation" ? "active" : ""} aria-pressed={showingPaper && paperDisplayMode === "translation"} onClick={() => { setPaperDisplayMode("translation"); changeView("paper"); }}>
                <Languages />{t("translationOnly")}
              </button>
            </>
          )}
        </div>
        <button className="pdf-translate-command" type="button" onClick={requestPaperTranslation} disabled={analysis.status === "running" || translationJob?.status === "running"}>
          {analysis.status === "running" || translationJob?.status === "running" ? <LoaderCircle className="spin" /> : <Languages />}
          {translationJob && translationJob.completedUnits < translationJob.totalUnits ? t("resumeTranslation") : t("translatePaper")}
        </button>
        {translationJob?.status === "running" && (
          <button className="pdf-pause-command" type="button" onClick={pausePaperTranslation}><Pause />{t("pauseTranslation")}</button>
        )}
        {analysis.status === "running" && <span>{t("pdfAnalysisProgress", { current: analysis.completedPages, total: analysis.totalPages })}</span>}
        {translationJob && <span>{t("paperTranslationProgress", { current: translationJob.completedUnits, total: translationJob.totalUnits })}</span>}
        {analysis.status === "failed" && <span className="pdf-analysis-error">{t("pdfAnalysisFailed")}</span>}
        {translationError && <span className="pdf-analysis-error">{translationError}</span>}
      </div>
      {showingPaper && analysis.document && translationJob ? (
        <article className={`pdf-paper-document mode-${paperDisplayMode}`}>
          <div className="pdf-paper-columns" aria-label={paperDisplayMode === "paired" ? t("pairedTranslation") : t("translationOnly")}>
            {paperDisplayMode === "paired" && <div className="pdf-paper-column-header">{t("sourceText")}</div>}
            <div className="pdf-paper-column-header">{t("translatedText")}</div>
            {analysis.document.pages.map((page) => {
              const blocks = analysis.document!.blocks.filter((block) => block.fragments[0]?.page === page.page);
              return (
                <section className="pdf-paper-page-content" key={page.page}>
                  <div className="pdf-paper-page-marker" data-paper-page={page.page}>
                    <span>{t("page", { page: page.page })}</span>
                  </div>
                  {paperDisplayMode === "paired" && pdfDocument && (
                    <div className="pdf-paper-visual-row">
                      <div>
                        <PdfPagePreview
                          pdf={pdfDocument}
                          pageNumber={page.page}
                          label={t("pdfPageVisual", { page: page.page })}
                          onError={handleRenderError}
                        />
                      </div>
                      <p>{t("pdfVisualReference")}</p>
                    </div>
                  )}
                  {blocks.length === 0 ? (
                    <p className="pdf-paper-empty-page">{t(page.quality === "rejected" ? "pdfVisualFallback" : "pdfPageEmpty")}</p>
                  ) : blocks.map((block) => {
                    const result = translationResults.get(block.id);
                    const preserved = block.kind === "equation" || block.kind === "reference";
                    return (
                      <div
                        className={`pdf-paper-row ${activeBlockId === block.id ? "active" : ""}`}
                        data-block-id={block.id}
                        key={`${page.page}-${block.id}`}
                        onClick={() => selectBlock(block)}
                        onPointerUp={() => handlePaperSelection(block)}
                      >
                        {paperDisplayMode === "paired" && (
                          <div className={`pdf-paper-source pdf-block-${block.kind}`}>
                            <span className="pdf-block-kind">{t(`pdfBlock_${block.kind}` as TranslationKey)}</span>
                            <span>{block.text}</span>
                          </div>
                        )}
                        <div className="pdf-paper-translation">
                          {result ? <p>{result.translatedText}</p> : preserved ? <p className="pdf-preserved-text">{block.text}</p> : (
                            <span>{translationJob.status === "running" ? t("translationPending") : t("translationNotCompleted")}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
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
              activeFragments={analysis.document?.blocks.find((block) => block.id === activeBlockId)?.fragments}
              onTextSelection={selectSourceItems}
              onError={handleRenderError}
            />
          ))}
        </div>
      ) : singlePage && (
        <PdfCanvas
          page={singlePage}
          availableWidth={availableWidth}
          label={t("pdfPage", { page: pageNumber, total: pageCount || "..." })}
          activeFragments={analysis.document?.blocks.find((block) => block.id === activeBlockId)?.fragments}
          onTextSelection={selectSourceItems}
          onError={handleRenderError}
        />
      )}
      {translationDialogOpen && analysis.document && (
        <PdfTranslationDialog
          blockCount={paperUnits.length}
          characterCount={paperUnits.reduce((total, unit) => total + unit.text.length, 0)}
          t={t}
          onClose={() => setTranslationDialogOpen(false)}
          onConfirm={(config, targetLanguage) => void runPaperTranslation(config, targetLanguage)}
        />
      )}
      {!showingPaper && <div className="page-status" aria-live="polite">{pageNumber} / {pageCount || "..."}</div>}
    </div>
  );
}
