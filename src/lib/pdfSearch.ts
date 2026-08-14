import { findTextMatches } from "./readerSearch";
import type { PdfPaperFragment } from "./pdfText";
import type { ReaderSearchResult } from "../types/reader";

export const MAX_PDF_SEARCH_PAGES = 300;
export const MAX_PDF_SEARCH_CHARACTERS = 2_000_000;
export const MAX_PDF_SEARCH_ITEMS_PER_PAGE = 20_000;

export interface PdfSearchTextItem {
  text: string;
  sourceIndex: number;
  fragment: PdfPaperFragment;
}

export interface PdfSearchMatch extends ReaderSearchResult {
  fragments: PdfPaperFragment[];
}

function isCjk(character: string): boolean {
  return /[\u2e80-\u9fff\uf900-\ufaff]/u.test(character);
}

function separatorBetween(previous: string, next: string): string {
  const left = previous.at(-1) ?? "";
  const right = next[0] ?? "";
  if (!left || !right || /\s/u.test(left) || /\s/u.test(right) || isCjk(left) || isCjk(right)) return "";
  if (left === "-" || left === "\u00ad") return "";
  return " ";
}

export function searchPdfTextItems(
  items: PdfSearchTextItem[],
  query: string,
  options: { page: number; label: string; maxResults: number },
): { results: PdfSearchMatch[]; truncated: boolean; characterCount: number } {
  const ranges: Array<{ start: number; end: number; item: PdfSearchTextItem }> = [];
  let text = "";
  for (const item of items) {
    const normalized = item.text.replace(/\s+/gu, " ").trim();
    if (!normalized) continue;
    if (text) text += separatorBetween(text, normalized);
    const start = text.length;
    text += normalized;
    ranges.push({ start, end: text.length, item });
  }
  const outcome = findTextMatches(text, query, {
    maxResults: options.maxResults,
    idPrefix: `pdf-${options.page}`,
    label: options.label,
  });
  return {
    characterCount: text.length,
    truncated: outcome.truncated,
    results: outcome.results.map((result) => ({
      ...result,
      target: `${options.page}:${result.start}`,
      fragments: ranges
        .filter((range) => range.end > result.start && range.start < result.end)
        .map((range) => range.item.fragment),
    })),
  };
}
