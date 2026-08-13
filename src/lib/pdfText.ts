export const PDF_TEXT_ALGORITHM_VERSION = 1;
export const MAX_PDF_ANALYSIS_PAGES = 300;
export const MAX_PDF_TEXT_ITEMS_PER_PAGE = 20_000;
export const MAX_PDF_ANALYSIS_CHARACTERS = 2_000_000;

export type PdfPaperBlockKind =
  | "title"
  | "heading"
  | "paragraph"
  | "list-item"
  | "caption"
  | "footnote"
  | "equation"
  | "reference";

export type PdfPageQuality = "supported" | "review" | "rejected";
export type PdfPageIssue =
  | "insufficient-text"
  | "vertical-text"
  | "formula-heavy"
  | "fragment-limit"
  | "over-fragmented"
  | "invalid-text-layer"
  | "ambiguous-columns";

export interface PdfRawTextItem {
  str: string;
  dir: string;
  transform: readonly number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
  coordinateSpace?: "pdf" | "viewport";
}

export interface PdfNormalizedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfPaperFragment extends PdfNormalizedRect {
  page: number;
}

export interface PdfPaperBlock {
  id: string;
  kind: PdfPaperBlockKind;
  text: string;
  readingOrder: number;
  column: "left" | "right" | "span";
  fragments: PdfPaperFragment[];
  confidence: number;
}

export interface PdfAnalyzedPage {
  page: number;
  width: number;
  height: number;
  quality: PdfPageQuality;
  confidence: number;
  issues: PdfPageIssue[];
  columnCount: 1 | 2;
  sourceItemCount: number;
  characterCount: number;
  blocks: PdfPaperBlock[];
}

export interface PdfPaperDocument {
  algorithmVersion: number;
  pages: PdfAnalyzedPage[];
  blocks: PdfPaperBlock[];
  translatedBlockCount: number;
  rejectedPages: number[];
  reviewPages: number[];
  characterCount: number;
}

interface NormalizedItem extends PdfNormalizedRect {
  text: string;
  fontHeight: number;
  vertical: boolean;
}

interface TextLine extends PdfNormalizedRect {
  text: string;
  fontHeight: number;
  column: PdfPaperBlock["column"];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

function percentile(values: number[], position: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * position)))] ?? 0;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function rectUnion(items: PdfNormalizedRect[]): PdfNormalizedRect {
  const left = Math.min(...items.map((item) => item.left));
  const top = Math.min(...items.map((item) => item.top));
  const right = Math.max(...items.map((item) => item.left + item.width));
  const bottom = Math.max(...items.map((item) => item.top + item.height));
  return { left: clamp(left), top: clamp(top), width: clamp(right - left), height: clamp(bottom - top) };
}

function normalizeExtractedText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  const tokens = text.split(" ");
  if (tokens.length >= 3 && !/[a-z]/u.test(text) && tokens.every((token) => /^[A-Z]{1,2}$/u.test(token))) return tokens.join("");
  return text;
}

function normalizeItem(item: PdfRawTextItem, pageWidth: number, pageHeight: number): NormalizedItem | undefined {
  const text = normalizeExtractedText(item.str);
  if (!text || item.transform.length < 6 || pageWidth <= 0 || pageHeight <= 0) return undefined;
  const [a = 0, b = 0, c = 0, d = 0, x = 0, baseline = 0] = item.transform;
  const angle = Math.atan2(b, a) * 180 / Math.PI;
  const vertical = item.dir === "ttb" || Math.abs(angle) > 8 || Math.abs(c) > Math.abs(d) * 0.35;
  const fontHeight = Math.max(1, item.height || Math.hypot(c, d) || Math.hypot(a, b));
  const width = Math.max(0.5, Math.abs(item.width));
  const top = item.coordinateSpace === "viewport"
    ? clamp((baseline - fontHeight) / pageHeight)
    : clamp((pageHeight - baseline - fontHeight) / pageHeight);
  return {
    text,
    left: clamp(x / pageWidth),
    top,
    width: clamp(width / pageWidth),
    height: clamp(fontHeight / pageHeight),
    fontHeight: fontHeight / pageHeight,
    vertical,
  };
}

function isCjk(character: string): boolean {
  return /[\u2e80-\u9fff\uf900-\ufaff]/u.test(character);
}

function joinText(previous: string, next: string, gap: number, fontHeight: number): string {
  if (!previous) return next;
  if (previous.endsWith("\u00ad") && /^[a-z]/u.test(next)) return `${previous.slice(0, -1)}${next}`;
  if (previous.endsWith("-") && /^[a-z]/u.test(next)) return previous + next;
  const last = previous.at(-1) ?? "";
  const first = next[0] ?? "";
  if (/\s$/u.test(previous) || /^\s/u.test(next) || isCjk(last) || isCjk(first) || gap <= fontHeight * 0.18) return previous + next;
  return `${previous} ${next}`;
}

function buildLines(items: NormalizedItem[]): TextLine[] {
  const horizontal = items.filter((item) => !item.vertical).sort((a, b) => a.top - b.top || a.left - b.left);
  const rows: NormalizedItem[][] = [];
  for (const item of horizontal) {
    const row = rows.findLast((candidate) => {
      const reference = candidate[0];
      return reference && Math.abs(reference.top - item.top) <= Math.max(reference.fontHeight, item.fontHeight) * 0.45;
    });
    if (row) row.push(item);
    else rows.push([item]);
  }

  const lines: TextLine[] = [];
  for (const row of rows) {
    const sorted = [...row].sort((a, b) => a.left - b.left);
    const groups: NormalizedItem[][] = [[]];
    for (const item of sorted) {
      const group = groups.at(-1)!;
      const previous = group.at(-1);
      const gap = previous ? item.left - previous.left - previous.width : 0;
      if (previous && gap > Math.max(0.04, Math.max(previous.fontHeight, item.fontHeight) * 2.5)) groups.push([]);
      groups.at(-1)!.push(item);
    }
    for (const group of groups) {
      if (group.length === 0) continue;
      let text = "";
      let previous: NormalizedItem | undefined;
      for (const item of group) {
        const gap = previous ? item.left - previous.left - previous.width : 0;
        text = joinText(text, item.text, gap, Math.max(previous?.fontHeight ?? 0, item.fontHeight));
        previous = item;
      }
      const rect = rectUnion(group);
      lines.push({ ...rect, text: text.trim(), fontHeight: median(group.map((item) => item.fontHeight)), column: "span" });
    }
  }
  return lines.filter((line) => line.text.length > 0);
}

function classifyColumns(lines: TextLine[]): 1 | 2 {
  const candidates = lines.filter((line) => line.width < 0.62 && line.top > 0.06 && line.top < 0.94);
  const left = candidates.filter((line) => line.left + line.width / 2 < 0.46);
  const right = candidates.filter((line) => line.left + line.width / 2 > 0.54);
  if (left.length < 3 || right.length < 3) return 1;
  const leftRange = [Math.min(...left.map((line) => line.top)), Math.max(...left.map((line) => line.top))];
  const rightRange = [Math.min(...right.map((line) => line.top)), Math.max(...right.map((line) => line.top))];
  return Math.min(leftRange[1]!, rightRange[1]!) - Math.max(leftRange[0]!, rightRange[0]!) > 0.08 ? 2 : 1;
}

function orderLines(lines: TextLine[], columnCount: 1 | 2): TextLine[] {
  if (columnCount === 1) return [...lines].sort((a, b) => a.top - b.top || a.left - b.left).map((line) => ({ ...line, column: "span" }));
  const classified = lines.map((line) => {
    const spans = line.width > 0.58 || (line.left < 0.32 && line.left + line.width > 0.68);
    return { ...line, column: spans ? "span" as const : line.left + line.width / 2 < 0.5 ? "left" as const : "right" as const };
  });
  const spans = classified.filter((line) => line.column === "span").sort((a, b) => a.top - b.top);
  const output: TextLine[] = [];
  let start = 0;
  for (const span of [...spans, undefined]) {
    const end = span?.top ?? 1.01;
    const scoped = classified.filter((line) => line.column !== "span" && line.top >= start && line.top < end);
    output.push(...scoped.filter((line) => line.column === "left").sort((a, b) => a.top - b.top));
    output.push(...scoped.filter((line) => line.column === "right").sort((a, b) => a.top - b.top));
    if (span) {
      output.push(span);
      start = span.top + span.height * 0.5;
    }
  }
  return output;
}

function lineKind(line: TextLine, medianHeight: number, index: number): PdfPaperBlockKind {
  const text = line.text.trim();
  if (/^(fig(?:ure)?|table|图|表)\s*[\dIVX一二三四五六七八九十]+[.：:]?/iu.test(text)) return "caption";
  if (/^(?:[-•▪◦]|\d+[.)])\s+/u.test(text)) return "list-item";
  if (line.top > 0.78 && line.fontHeight < medianHeight * 0.88) return "footnote";
  const mathCharacters = (text.match(/[=≈≠≤≥∑∫√∞±×÷^_{}<>α-ωΑ-Ω]/gu) ?? []).length;
  if (text.length < 180 && mathCharacters / Math.max(1, text.length) > 0.16) return "equation";
  if (index === 0 && line.fontHeight > medianHeight * 1.35 && text.length < 240) return "title";
  if ((line.fontHeight > medianHeight * 1.18 && text.length < 180) || /^(?:\d+(?:\.\d+)*\s+)?(?:abstract|introduction|methods?|results?|discussion|conclusion|references|摘要|引言|方法|结果|讨论|结论|参考文献)\b/iu.test(text)) return "heading";
  return "paragraph";
}

function blockText(lines: TextLine[]): string {
  let result = "";
  const maximumWidth = Math.max(...lines.map((line) => line.width), 0);
  for (const line of lines) {
    if (!result) result = line.text;
    else if (result.endsWith("-") && /^[a-z]/u.test(line.text) && (lines[lines.indexOf(line) - 1]?.width ?? 0) >= maximumWidth * 0.82) {
      result = `${result.slice(0, -1)}${line.text}`;
    } else result = joinText(result, line.text, 1, 0);
  }
  return result.trim();
}

function isParagraphLike(kind: PdfPaperBlockKind): boolean {
  return kind === "paragraph" || kind === "list-item" || kind === "footnote" || kind === "caption";
}

function isHeadingLike(kind: PdfPaperBlockKind): boolean {
  return kind === "title" || kind === "heading";
}

function linesToBlocks(lines: TextLine[], page: number, medianHeight: number): PdfPaperBlock[] {
  const groups: Array<{ kind: PdfPaperBlockKind; lines: TextLine[] }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const kind = lineKind(line, medianHeight, index);
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.lines.at(-1);
    const gap = previous ? line.top - previous.top - previous.height : Number.POSITIVE_INFINITY;
    const previousShort = previous ? previous.width < (previous.column === "span" ? 0.52 : 0.31) : false;
    const sameHeadingGroup = previousGroup && isHeadingLike(previousGroup.kind) && isHeadingLike(kind);
    const comparableHeadingSize = previous ? Math.abs(previous.fontHeight - line.fontHeight) <= medianHeight * 0.35 : false;
    const sameBodyGroup = previousGroup && previousGroup.kind === kind && isParagraphLike(kind);
    const canJoin = previousGroup && previous && previous.column === line.column
      && Math.abs(previous.left - line.left) <= (isHeadingLike(kind) ? 0.08 : 0.055)
      && ((sameBodyGroup && gap <= Math.max(0.021, medianHeight * 1.2)
        && !(previousShort && /[.!?。！？:]$/u.test(previous.text)))
        || (sameHeadingGroup && comparableHeadingSize && gap <= Math.max(0.025, medianHeight * 1.45)));
    if (canJoin) {
      previousGroup.lines.push(line);
      if (previousGroup.kind === "heading" && kind === "title") previousGroup.kind = "title";
    } else groups.push({ kind, lines: [line] });
  }

  return groups.map((group, index) => {
    const rect = rectUnion(group.lines);
    const text = blockText(group.lines);
    const column = group.lines[0]?.column ?? "span";
    const identity = `${PDF_TEXT_ALGORITHM_VERSION}|${page}|${column}|${Math.round(rect.left * 250)}|${Math.round(rect.top * 250)}|${text}`;
    return {
      id: `pdfb_${stableHash(identity)}`,
      kind: group.kind,
      text,
      readingOrder: index,
      column,
      fragments: [{ page, ...rect }],
      confidence: 1,
    };
  });
}

function isInvalidTextLayerCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x08 || code === 0x0b || code === 0x0c || code >= 0x0e && code <= 0x1f
    || code === 0xfffd || code >= 0xe000 && code <= 0xf8ff;
}

export function analyzePdfTextPage(input: {
  page: number;
  width: number;
  height: number;
  items: PdfRawTextItem[];
}): PdfAnalyzedPage {
  const { page, width, height } = input;
  if (input.items.length > MAX_PDF_TEXT_ITEMS_PER_PAGE) {
    return {
      page, width, height, quality: "rejected", confidence: 0, issues: ["fragment-limit"], columnCount: 1,
      sourceItemCount: input.items.length, characterCount: 0, blocks: [],
    };
  }
  const items = input.items.map((item) => normalizeItem(item, width, height)).filter((item): item is NormalizedItem => Boolean(item));
  const verticalCount = items.filter((item) => item.vertical).length;
  const lines = buildLines(items);
  const bodyLineHeights = lines.filter((line) => line.top >= 0.08 && line.top + line.height <= 0.92).map((line) => line.fontHeight);
  const medianHeight = percentile(bodyLineHeights.length > 0 ? bodyLineHeights : lines.map((line) => line.fontHeight), 0.35) || 0.015;
  const columnCount = classifyColumns(lines);
  const ordered = orderLines(lines, columnCount);
  const blocks = linesToBlocks(ordered, page, medianHeight).filter((block) => !/^\d{1,4}$/u.test(block.text) || block.fragments[0]!.top > 0.15 && block.fragments[0]!.top < 0.85);
  const characterCount = blocks.reduce((total, block) => total + block.text.length, 0);
  const rawText = items.map((item) => item.text).join("");
  const invalidCharacters = [...rawText].filter(isInvalidTextLayerCharacter).length;
  const semanticCharacters = (rawText.match(/[\p{L}\p{N}\p{P}\p{Zs}]/gu) ?? []).length;
  const formulaCharacters = blocks.filter((block) => block.kind === "equation").reduce((total, block) => total + block.text.length, 0);
  const issues: PdfPageIssue[] = [];
  if (characterCount < 40) issues.push("insufficient-text");
  if (verticalCount / Math.max(1, items.length) > 0.08) issues.push("vertical-text");
  if (formulaCharacters / Math.max(1, characterCount) > 0.35) issues.push("formula-heavy");
  if (invalidCharacters / Math.max(1, rawText.length) > 0.02 || semanticCharacters / Math.max(1, rawText.length) < 0.55) issues.push("invalid-text-layer");
  if (columnCount === 2 && blocks.filter((block) => block.column === "left").length < 2) issues.push("ambiguous-columns");
  if (blocks.length > 80 || blocks.length > Math.max(24, characterCount / 45)) issues.push("over-fragmented");
  const spanningTransitions = blocks.filter((block) => block.column === "span" && block.fragments[0]!.top > 0.08 && block.fragments[0]!.top < 0.9).length;
  if (columnCount === 2 && spanningTransitions > 2) issues.push("ambiguous-columns");
  const rejected = characterCount < 40 || verticalCount / Math.max(1, items.length) > 0.25
    || formulaCharacters / Math.max(1, characterCount) > 0.55 || issues.includes("invalid-text-layer");
  const confidence = clamp(1 - (characterCount < 100 ? 0.25 : 0) - verticalCount / Math.max(1, items.length) - formulaCharacters / Math.max(1, characterCount) * 0.35 - (issues.includes("ambiguous-columns") ? 0.2 : 0));
  return {
    page, width, height, quality: rejected ? "rejected" : issues.length > 0 ? "review" : "supported",
    confidence, issues, columnCount, sourceItemCount: input.items.length, characterCount, blocks: rejected ? [] : blocks,
  };
}

function marginalSignature(block: PdfPaperBlock): string | undefined {
  const fragment = block.fragments[0];
  if (!fragment || block.text.length > 120 || fragment.top >= 0.09 && fragment.top + fragment.height <= 0.92) return undefined;
  return block.text.toLocaleLowerCase().replace(/\d+/gu, "#").replace(/\s+/gu, " ").trim();
}

function mergeCrossPageBlocks(blocks: PdfPaperBlock[]): PdfPaperBlock[] {
  const merged: PdfPaperBlock[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    const crossesPage = previous && previous.kind === "paragraph" && block.kind === "paragraph"
      && previous.fragments.at(-1)!.page + 1 === block.fragments[0]!.page
      && previous.fragments.at(-1)!.top > 0.68 && block.fragments[0]!.top < 0.22;
    if (crossesPage && /[-\u00ad]$/u.test(previous.text) && /^[a-z]/u.test(block.text)) {
      const text = `${previous.text.replace(/[-\u00ad]$/u, "")}${block.text}`;
      merged[merged.length - 1] = {
        ...previous,
        id: `pdfb_${stableHash(`${previous.id}|${block.id}|${text}`)}`,
        text,
        fragments: [...previous.fragments, ...block.fragments],
        confidence: Math.min(previous.confidence, block.confidence),
      };
    } else merged.push(block);
  }
  return merged;
}

export function buildPdfPaperDocument(pages: PdfAnalyzedPage[]): PdfPaperDocument {
  const orderedPages = [...pages].sort((a, b) => a.page - b.page);
  const signaturePages = new Map<string, Set<number>>();
  for (const page of orderedPages) {
    for (const block of page.blocks) {
      const signature = marginalSignature(block);
      if (!signature) continue;
      const occurrences = signaturePages.get(signature) ?? new Set<number>();
      occurrences.add(page.page);
      signaturePages.set(signature, occurrences);
    }
  }
  const recurring = new Set([...signaturePages].filter(([, occurrences]) => occurrences.size >= Math.max(3, Math.ceil(orderedPages.length * 0.25))).map(([signature]) => signature));
  const blocks = mergeCrossPageBlocks(orderedPages.flatMap((page) => page.blocks.filter((block) => {
    const signature = marginalSignature(block);
    return !signature || !recurring.has(signature);
  }))).map((block, index) => ({ ...block, readingOrder: index }));
  const supportedPages = new Set(orderedPages.filter((page) => page.quality === "supported").map((page) => page.page));
  return {
    algorithmVersion: PDF_TEXT_ALGORITHM_VERSION,
    pages: orderedPages,
    blocks,
    translatedBlockCount: blocks.filter((block) => block.kind !== "equation" && block.kind !== "reference"
      && block.fragments.every((fragment) => supportedPages.has(fragment.page))).length,
    rejectedPages: orderedPages.filter((page) => page.quality === "rejected").map((page) => page.page),
    reviewPages: orderedPages.filter((page) => page.quality === "review").map((page) => page.page),
    characterCount: blocks.reduce((total, block) => total + block.text.length, 0),
  };
}
