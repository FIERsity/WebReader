export interface TextPageLayout {
  viewportWidth: number;
  contentWidth: number;
  contentHeight: number;
  sideInset: number;
  topInset: number;
  bottomInset: number;
}

interface SourceRange {
  start: number;
  end: number;
}

const DESKTOP_SIDE_INSET = 82;
const COMPACT_SIDE_INSET = 48;
const DESKTOP_TOP_INSET = 52;
const COMPACT_TOP_INSET = 34;
const DESKTOP_BOTTOM_INSET = 100;
const COMPACT_BOTTOM_INSET = 90;
const MIN_CONTENT_WIDTH = 160;
const MIN_CONTENT_HEIGHT = 120;

export function calculateTextPageLayout(
  viewportWidth: number,
  viewportHeight: number,
  preferredContentWidth: number,
): TextPageLayout {
  const width = Math.max(1, Math.floor(viewportWidth));
  const height = Math.max(1, Math.floor(viewportHeight));
  const compact = width <= 760;
  const minimumSideInset = compact ? COMPACT_SIDE_INSET : DESKTOP_SIDE_INSET;
  const topInset = compact ? COMPACT_TOP_INSET : DESKTOP_TOP_INSET;
  const bottomInset = compact ? COMPACT_BOTTOM_INSET : DESKTOP_BOTTOM_INSET;
  const availableWidth = Math.max(MIN_CONTENT_WIDTH, width - minimumSideInset * 2);
  const contentWidth = Math.min(Math.max(MIN_CONTENT_WIDTH, preferredContentWidth), availableWidth);

  return {
    viewportWidth: width,
    contentWidth,
    contentHeight: Math.max(MIN_CONTENT_HEIGHT, height - topInset - bottomInset),
    sideInset: Math.max(0, (width - contentWidth) / 2),
    topInset,
    bottomInset,
  };
}

export function pageIndexAtPosition(position: number, pageWidth: number, pageCount = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(position) || !Number.isFinite(pageWidth) || pageWidth <= 0) return 0;
  const index = Math.max(0, Math.round(position / pageWidth));
  return Number.isFinite(pageCount) ? Math.min(index, Math.max(0, pageCount - 1)) : index;
}

export function pageCountForExtent(scrollExtent: number, pageWidth: number): number {
  if (!Number.isFinite(scrollExtent) || !Number.isFinite(pageWidth) || pageWidth <= 0) return 1;
  return Math.max(1, Math.ceil(scrollExtent / pageWidth));
}

export function findSourceRangeIndex(ranges: SourceRange[], offset: number): number {
  if (ranges.length === 0) return -1;
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ranges[middle]!.start <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

export function sourceOffsetForRange(ranges: SourceRange[], offset: number): { index: number; offset: number } | undefined {
  if (ranges.length === 0) return undefined;
  const index = findSourceRangeIndex(ranges, offset);
  const range = ranges[index]!;
  if (offset <= range.end || index === ranges.length - 1) {
    return { index, offset: Math.min(range.end, Math.max(range.start, offset)) };
  }
  const next = ranges[index + 1]!;
  return { index: index + 1, offset: next.start };
}
