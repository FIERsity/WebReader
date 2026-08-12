import { useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import type { ReaderPreferences, ReadingLocator } from "../types/library";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfReaderProps {
  file: Blob;
  locator?: ReadingLocator;
  preferences: ReaderPreferences;
  onProgress: (locator: ReadingLocator) => void;
  navigationRef: React.RefObject<{ previous: () => void; next: () => void } | null>;
}

export function PdfReader({ file, locator, preferences, onProgress, navigationRef }: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(() => {
    const parsed = locator?.type === "pdf" ? Number(locator.value) : 1;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  });
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    let task: ReturnType<typeof getDocument> | undefined;
    void file.arrayBuffer().then((data) => {
      if (!active) return;
      task = getDocument({
        data,
        useWorkerFetch: false,
      });
      return task.promise;
    }).then((pdf) => {
      if (!active || !pdf) return;
      documentRef.current = pdf;
      setPageCount(pdf.numPages);
      setPageNumber((current) => Math.min(current, pdf.numPages));
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "This PDF could not be opened.");
    });
    return () => {
      active = false;
      documentRef.current = null;
      void task?.destroy();
    };
  }, [file]);

  useEffect(() => {
    const pdf = documentRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas || pageCount === 0) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | undefined;

    void pdf.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const availableWidth = Math.min(1100, Math.max(320, window.innerWidth - 96));
      const scale = Math.min(2.25, Math.max(0.7, availableWidth / base.width));
      const viewport = page.getViewport({ scale });
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas is unavailable in this browser.");
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
      renderTask = page.render({ canvas, canvasContext: context, viewport, transform });
      return renderTask.promise;
    }).catch((reason: unknown) => {
      if ((reason as { name?: string })?.name !== "RenderingCancelledException") {
        setError(reason instanceof Error ? reason.message : "The PDF page could not be rendered.");
      }
    });

    onProgress({
      type: "pdf",
      value: String(pageNumber),
      progression: pageCount <= 1 ? 1 : (pageNumber - 1) / (pageCount - 1),
      label: `Page ${pageNumber}`,
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [onProgress, pageCount, pageNumber]);

  useEffect(() => {
    navigationRef.current = {
      previous: () => setPageNumber((page) => Math.max(1, page - 1)),
      next: () => setPageNumber((page) => Math.min(pageCount || page, page + 1)),
    };
    return () => { navigationRef.current = null; };
  }, [navigationRef, pageCount]);

  if (error) return <p className="reader-error">{error}</p>;

  return (
    <div className={`reader-stage pdf-stage theme-${preferences.theme}`}>
      <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber} of ${pageCount || "..."}`} />
      <div className="page-status" aria-live="polite">{pageNumber} / {pageCount || "..."}</div>
    </div>
  );
}
