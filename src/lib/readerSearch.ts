import type { ReaderSearchResult } from "../types/reader";

export const MAX_SEARCH_QUERY_LENGTH = 200;
export const MAX_SEARCH_RESULTS = 200;
const EXCERPT_CONTEXT = 48;

export interface TextSearchMatch extends ReaderSearchResult {
  start: number;
  end: number;
}

export function findTextMatches(
  text: string,
  query: string,
  options: { maxResults?: number; idPrefix?: string; label?: string; baseOffset?: number } = {},
): { results: TextSearchMatch[]; truncated: boolean } {
  const normalizedQuery = query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
  const maxResults = Math.max(1, options.maxResults ?? MAX_SEARCH_RESULTS);
  if (!normalizedQuery) return { results: [], truncated: false };
  const matcher = new RegExp(normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const results: TextSearchMatch[] = [];
  let truncated = false;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    if (results.length >= maxResults) {
      truncated = true;
      break;
    }
    const start = match.index;
    const end = start + match[0].length;
    const absoluteStart = (options.baseOffset ?? 0) + start;
    results.push({
      id: `${options.idPrefix ?? "text"}-${absoluteStart}-${results.length}`,
      target: String(absoluteStart),
      label: options.label,
      start: absoluteStart,
      end: (options.baseOffset ?? 0) + end,
      excerpt: {
        pre: text.slice(Math.max(0, start - EXCERPT_CONTEXT), start),
        match: text.slice(start, end),
        post: text.slice(end, Math.min(text.length, end + EXCERPT_CONTEXT)),
      },
    });
  }
  return { results, truncated };
}

export function throwIfSearchAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");
}
