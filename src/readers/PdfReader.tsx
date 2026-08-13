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
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [pageNumber, setPageNumber] = useState(initialLocationRef.current.page);
  const [pageCount, setPageCount] = useState(0);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const [pageAspectRatios, setPageAspectRatios] = useState<number[]>([]);
  const [singlePage, setSinglePage] = useState<PDFPageProxy>();
  const [error, setError] = useState<TranslationKey>();
  const continuous = readingProfile === "article";
  const availableWidth = Math.min(1100, Math.max(220, stageWidth - (continuous ? 48 : 124)));
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
        if (continuous && layout.heights.length > 0 && !restoringRef.current) {
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
  }, [continuous, stageElement]);

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
    if (!pdf || continuous || pageCount === 0) {
      setSinglePage(undefined);
      return;
    }
    let active = true;
    void pdf.getPage(pageNumber).then((page) => {
      if (active) setSinglePage(page);
      else page.cleanup();
    }).catch(handleRenderError);
    return () => { active = false; };
  }, [continuous, handleRenderError, pageCount, pageNumber]);

  useEffect(() => {
    if (continuous || !singlePage || pageCount === 0) return;
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
  }, [continuous, onCurrentTarget, onProgress, pageCount, pageNumber, singlePage, t]);

  const saveContinuousPosition = useCallback((stageOverride?: HTMLDivElement) => {
    const stage = stageOverride ?? stageRef.current;
    if (!stage || !continuous || restoringRef.current || pageCount === 0 || pageLayout.heights.length === 0) return;
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
  }, [continuous, onCurrentTarget, onProgress, pageCount, pageLayout, t]);

  useEffect(() => {
    const stage = stageElement;
    if (!stage || !continuous || !pdfDocument || pageCount === 0 || pageLayout.heights.length === 0) return;
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
  }, [continuous, pageCount, pageLayout, pdfDocument, saveContinuousPosition, stageElement]);

  useLayoutEffect(() => {
    const stage = stageElement;
    if (!stage || !continuous || !pdfDocument || pageLayout.heights.length === 0) return;
    stage.scrollTop = scrollTopForPdfLocation(pageLayout, currentLocationRef.current);
    restoringRef.current = false;
    saveContinuousPosition(stage);
  }, [continuous, pageLayout, pdfDocument, saveContinuousPosition, stageElement]);

  useEffect(() => {
    const stage = stageElement;
    if (!stage || continuous) return;
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
  }, [continuous, pageCount, stageElement]);

  useEffect(() => {
    navigationRef.current = {
      previous: () => {
        if (continuous) stageRef.current?.scrollBy({ top: -(stageRef.current.clientHeight * 0.86), behavior: "smooth" });
        else {
          pendingSingleScrollRef.current = "end";
          setPageNumber((page) => Math.max(1, page - 1));
        }
      },
      next: () => {
        if (continuous) stageRef.current?.scrollBy({ top: stageRef.current.clientHeight * 0.86, behavior: "smooth" });
        else {
          pendingSingleScrollRef.current = "start";
          setPageNumber((page) => Math.min(pageCount || page, page + 1));
        }
      },
      goTo: (target) => {
        const page = Number(target.split(":", 1)[0]);
        if (!Number.isInteger(page)) return;
        const safePage = Math.max(1, Math.min(pageCount || page, page));
        if (continuous) {
          stageRef.current?.scrollTo({ top: pageLayout.offsets[safePage - 1] ?? 0, behavior: "smooth" });
        } else {
          pendingSingleScrollRef.current = "start";
          setPageNumber(safePage);
        }
      },
    };
    return () => { navigationRef.current = null; };
  }, [continuous, navigationRef, pageCount, pageLayout]);

  if (error) return <p className="reader-error">{t(error)}</p>;

  return (
    <div className={`reader-stage pdf-stage ${continuous ? "pdf-continuous" : "pdf-paginated"} theme-${preferences.theme}`} ref={setStage}>
      {continuous && pdfDocument ? (
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
      <div className="page-status" aria-live="polite">{pageNumber} / {pageCount || "..."}</div>
    </div>
  );
}
