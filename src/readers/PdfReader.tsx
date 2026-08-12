import { useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import { getPdfOutline } from "../lib/pdfOutline";
import { fitsCanvasLimit, MAX_PDF_CANVAS_PIXELS } from "../lib/pdfLimits";
import type { ReaderPreferences, ReadingLocator } from "../types/library";
import type { ReaderCapabilities, ReaderController, ReaderOutlineItem } from "../types/reader";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfReaderProps {
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

export function PdfReader({
  file, locator, preferences, onProgress, onOutline, onCapabilities,
  onCurrentTarget, navigationRef, t,
}: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const tRef = useRef(t);
  const [stageWidth, setStageWidth] = useState(0);
  const [pageNumber, setPageNumber] = useState(() => {
    const parsed = locator?.type === "pdf" ? Number(locator.value) : 1;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  });
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<TranslationKey>();

  useEffect(() => { tRef.current = t; }, [t]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const width = stage.clientWidth;
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
  }, []);

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
      setPageCount(pdf.numPages);
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
    }).catch(() => {
      if (active) setError("pdfOpenFailed");
    });
    return () => {
      active = false;
      documentRef.current = null;
      onOutline([]);
      onCapabilities({ typography: false, outline: false, publisherFont: false });
      void task?.destroy();
    };
  }, [file, onCapabilities, onOutline]);

  useEffect(() => {
    const pdf = documentRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas || pageCount === 0) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | undefined;

    void pdf.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const availableWidth = Math.min(1100, Math.max(220, stageWidth - 124));
      const scale = Math.min(2.25, Math.max(0.25, availableWidth / base.width));
      const viewport = page.getViewport({ scale });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      if (!fitsCanvasLimit(viewport.width, viewport.height, outputScale)) {
        throw new Error("PDF page exceeds the canvas safety limit.");
      }
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error(tRef.current("canvasUnavailable"));
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
      renderTask = page.render({ canvas, canvasContext: context, viewport, transform });
      return renderTask.promise;
    }).catch((reason: unknown) => {
      if ((reason as { name?: string })?.name !== "RenderingCancelledException") setError("pdfRenderFailed");
    });

    const target = String(pageNumber);
    onCurrentTarget(target);
    onProgress({
      type: "pdf",
      value: target,
      progression: pageCount <= 1 ? 1 : (pageNumber - 1) / (pageCount - 1),
      label: t("page", { page: pageNumber }),
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [onCurrentTarget, onProgress, pageCount, pageNumber, stageWidth, t]);

  useEffect(() => {
    navigationRef.current = {
      previous: () => setPageNumber((page) => Math.max(1, page - 1)),
      next: () => setPageNumber((page) => Math.min(pageCount || page, page + 1)),
      goTo: (target) => {
        const page = Number(target);
        if (Number.isInteger(page)) setPageNumber(Math.max(1, Math.min(pageCount || page, page)));
      },
    };
    return () => { navigationRef.current = null; };
  }, [navigationRef, pageCount]);

  if (error) return <p className="reader-error">{t(error)}</p>;

  return (
    <div className={`reader-stage pdf-stage theme-${preferences.theme}`} ref={stageRef}>
      <canvas ref={canvasRef} aria-label={t("pdfPage", { page: pageNumber, total: pageCount || "..." })} />
      <div className="page-status" aria-live="polite">{pageNumber} / {pageCount || "..."}</div>
    </div>
  );
}
