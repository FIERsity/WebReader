import type { PdfLocation } from "./pdfLocation";

export interface PdfPageLayout {
  offsets: number[];
  heights: number[];
  totalHeight: number;
}

export function buildPdfPageLayout(aspectRatios: number[], availableWidth: number, gap = 18): PdfPageLayout {
  const offsets: number[] = [];
  const heights: number[] = [];
  let totalHeight = 0;
  for (const ratioValue of aspectRatios) {
    const ratio = Number.isFinite(ratioValue) && ratioValue > 0 ? ratioValue : 1 / 1.414;
    offsets.push(totalHeight);
    const height = availableWidth / ratio + gap;
    heights.push(height);
    totalHeight += height;
  }
  return { offsets, heights, totalHeight };
}

export function locatePdfPosition(layout: PdfPageLayout, marker: number): PdfLocation {
  if (layout.heights.length === 0) return { page: 1, offset: 0 };
  const position = Math.max(0, Math.min(layout.totalHeight, marker));
  let low = 0;
  let high = layout.heights.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((layout.offsets[middle] ?? 0) <= position) low = middle;
    else high = middle - 1;
  }
  const height = layout.heights[low] ?? 1;
  return { page: low + 1, offset: Math.max(0, Math.min(1, (position - (layout.offsets[low] ?? 0)) / height)) };
}

export function scrollTopForPdfLocation(layout: PdfPageLayout, location: PdfLocation, markerOffset = 24): number {
  const index = Math.max(0, Math.min(layout.heights.length - 1, location.page - 1));
  const offset = Math.max(0, Math.min(1, location.offset));
  return Math.max(0, (layout.offsets[index] ?? 0) + (layout.heights[index] ?? 0) * offset - markerOffset);
}

export function pdfWindowForPage(page: number, pageCount: number, radius = 4): number[] {
  if (pageCount <= 0) return [];
  const safePage = Math.max(1, Math.min(pageCount, page));
  const first = Math.max(1, safePage - radius);
  const last = Math.min(pageCount, safePage + radius);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
