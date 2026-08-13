import { FileSearch, FileText, LocateFixed, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFPageProxy,
} from "pdfjs-dist";
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
import type { ReaderPreferences, ReadingLocator, ReadingProfile } from "../types/library";
import type { ReaderCapabilities, ReaderController, ReaderOutlineItem } from "../types/reader";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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

function toRawTextItem(item: PdfJsTextItem, viewport: ReturnType<PDFPageProxy["getViewport"]>): PdfRawTextItem {
  const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = item.transform;
  const [va = 0, vb = 0, vc = 0, vd = 0, ve = 0, vf = 0] = viewport.transform;
  return {
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
  onError: () => void;
}

function PdfCanvas({ page, availableWidth, label, onError }: PdfCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || availableWidth <= 0) return;
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
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
    const renderTask = page.render({ canvas, canvasContext: context, viewport, transform });
    void renderTask.promise.catch((reason: unknown) => {
      if ((reason as { name?: string })?.name !== "RenderingCancelledException") onError();
    });
    return () => {
      renderTask.cancel();
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    };
  }, [availableWidth, onError, page]);

  return <canvas ref={canvasRef} aria-label={label} />;
}

interface PdfPageSlotProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  availableWidth: number;
  pageTop: number;
  pageHeight: number;
  t: PdfReaderProps["t"];
  onError: () => void;
}

function PdfPageSlot({ pdf, pageNumber, availableWidth, pageTop, pageHeight, t, onError }: PdfPageSlotProps) {
  const [page, setPage] = useState<PDFPageProxy>();

  useEffect(() => {
    let active = true;
    void pdf.getPage(pageNumber).then((nextPage) => {
      if (active) setPage(nextPage);
      else nextPage.cleanup();
    }).catch(onError);
    return () => { active = false; };
  }, [onError, pageNumber, pdf]);

  return (
    <div className="continuous-pdf-page" data-page={pageNumber} style={{ top: pageTop, height: pageHeight }}>
      {page && <PdfCanvas page={page} availableWidth={availableWidth} label={t("pdfPage", { page: pageNumber, total: pdf.numPages })} onError={onError} />}
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
  const [viewMode, setViewMode] = useState<"pdf" | "paper">("pdf");
  const [activeBlockId, setActiveBlockId] = useState<string>();
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
            page.cleanup();
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
      else page.cleanup();
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
    let task: ReturnType<typeof getDocument> | undefined;
    try {
      const data = await file.arrayBuffer();
      if (controller.signal.aborted) return;
      task = getDocument({ data, useWorkerFetch: false, maxImageSize: MAX_PDF_CANVAS_PIXELS, canvasMaxAreaInBytes: MAX_PDF_CANVAS_PIXELS * 4 });
      const pdf = await task.promise;
      const pages = [];
      let characterCount = 0;
      for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
        if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const page = await pdf.getPage(pageIndex);
        try {
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
          const analyzed = analyzePdfTextPage({
            page: pageIndex,
            width: viewport.width,
            height: viewport.height,
            items: content.items.filter(isTextItem).map((item) => toRawTextItem(item, viewport)),
          });
          characterCount += analyzed.characterCount;
          if (characterCount > MAX_PDF_ANALYSIS_CHARACTERS) throw new RangeError("PDF analysis character limit exceeded");
          pages.push(analyzed);
        } finally {
          page.cleanup();
        }
        setAnalysis({ status: "running", completedPages: pageIndex, totalPages: pdf.numPages });
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      if (controller.signal.aborted) return;
      const document = buildPdfPaperDocument(pages);
      setAnalysis({ status: "ready", completedPages: pdf.numPages, totalPages: pdf.numPages, document });
      setViewMode("paper");
    } catch (reason) {
      if ((reason as { name?: string })?.name === "AbortError") {
        setAnalysis((current) => ({ ...current, status: "cancelled", document: undefined }));
      } else setAnalysis((current) => ({ ...current, status: "failed", document: undefined }));
    } finally {
      analysisAbortRef.current = undefined;
      await task?.destroy();
    }
  }, [analysis.status, file, pageCount]);

  useEffect(() => () => analysisAbortRef.current?.abort(), []);

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
      setActiveBlockId(undefined);
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

  const selectBlock = useCallback((block: PdfPaperBlock) => {
    setActiveBlockId(block.id);
    const page = block.fragments[0]?.page;
    if (page) {
      const offset = block.fragments[0]?.top ?? 0;
      currentLocationRef.current = { page, offset };
      setPageNumber(page);
      onCurrentTarget(String(page));
      const progression = pageCount <= 1 ? offset : Math.min(1, ((page - 1) + offset) / pageCount);
      onProgress({ type: "pdf", value: serializePdfLocation(page, offset), progression, label: t("page", { page }) });
    }
  }, [onCurrentTarget, onProgress, pageCount, t]);

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
          <button type="button" className={showingPaper ? "active" : ""} aria-pressed={showingPaper} onClick={() => changeView("paper")} disabled={analysis.status === "running"}>
            {analysis.status === "running" ? <LoaderCircle className="spin" /> : <FileSearch />}{t("paperStructure")}
          </button>
        </div>
        {analysis.status === "idle" && <span>{t("pdfAnalysisLocal")}</span>}
        {analysis.status === "running" && <span>{t("pdfAnalysisProgress", { current: analysis.completedPages, total: analysis.totalPages })}</span>}
        {analysis.status === "failed" && <span className="pdf-analysis-error">{t("pdfAnalysisFailed")}</span>}
      </div>
      {showingPaper && analysis.document ? (
        <article className="pdf-paper-document">
          <header className="pdf-paper-summary">
            <div><strong>{analysis.document.blocks.length}</strong><span>{t("pdfBlocks")}</span></div>
            <div><strong>{analysis.document.characterCount.toLocaleString()}</strong><span>{t("pdfCharacters")}</span></div>
            <div><strong>{analysis.document.reviewPages.length}</strong><span>{t("pdfReviewPages")}</span></div>
            <div><strong>{analysis.document.rejectedPages.length}</strong><span>{t("pdfRejectedPages")}</span></div>
          </header>
          {(analysis.document.reviewPages.length > 0 || analysis.document.rejectedPages.length > 0) && (
            <p className="pdf-paper-warning">{t("pdfAnalysisWarning", {
              pages: [...analysis.document.reviewPages, ...analysis.document.rejectedPages].join(", "),
            })}</p>
          )}
          <div className="pdf-paper-columns" aria-label={t("paperStructure")}>
            <div className="pdf-paper-column-header">{t("sourceText")}</div>
            <div className="pdf-paper-column-header">{t("translationPending")}</div>
            {analysis.document.pages.map((page) => {
              const blocks = analysis.document!.blocks.filter((block) => block.fragments[0]?.page === page.page);
              return (
                <section className={`pdf-paper-page-content quality-${page.quality}`} key={page.page}>
                  <div className="pdf-paper-page-marker" data-paper-page={page.page}>
                    <span>{t("page", { page: page.page })}</span>
                    {page.quality !== "supported" && <strong>{t(page.quality === "review" ? "pdfPageReview" : "pdfPageRejected")}</strong>}
                  </div>
                  {blocks.length === 0 ? (
                    <p className="pdf-paper-empty-page">{t(page.quality === "rejected" ? "pdfPageRejectedText" : "pdfPageEmpty")}</p>
                  ) : blocks.map((block) => (
                    <div className={`pdf-paper-row ${activeBlockId === block.id ? "active" : ""}`} key={`${page.page}-${block.id}`}>
                      <button className={`pdf-paper-source pdf-block-${block.kind}`} type="button" onClick={() => selectBlock(block)}>
                        <span className="pdf-block-kind">{t(`pdfBlock_${block.kind}` as TranslationKey)}</span>
                        <span>{block.text}</span>
                      </button>
                      <button className="pdf-paper-translation" type="button" onClick={() => selectBlock(block)}>
                        <LocateFixed /><span>{t("translationPending")}</span>
                      </button>
                    </div>
                  ))}
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
              onError={handleRenderError}
            />
          ))}
        </div>
      ) : singlePage && (
        <PdfCanvas page={singlePage} availableWidth={availableWidth} label={t("pdfPage", { page: pageNumber, total: pageCount || "..." })} onError={handleRenderError} />
      )}
      {!showingPaper && <div className="page-status" aria-live="polite">{pageNumber} / {pageCount || "..."}</div>}
    </div>
  );
}
