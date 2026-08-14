import type { TextBlock } from "./textDocument";

export type MarkdownInlineNode =
  | MarkdownInlineText
  | MarkdownInlineContainer
  | MarkdownInlineLink
  | MarkdownInlineImage
  | MarkdownInlineBreak;

export interface MarkdownInlineText {
  type: "text" | "code";
  start: number;
  end: number;
  text: string;
}

export interface MarkdownInlineContainer {
  type: "strong" | "emphasis" | "delete";
  start: number;
  end: number;
  children: MarkdownInlineNode[];
}

export interface MarkdownInlineLink {
  type: "link";
  start: number;
  end: number;
  href: string;
  children: MarkdownInlineNode[];
}

export interface MarkdownInlineImage {
  type: "image";
  start: number;
  end: number;
  alt: string;
  altStart: number;
  altEnd: number;
}

export interface MarkdownInlineBreak {
  type: "break";
  start: number;
  end: number;
}

export interface MarkdownListItem {
  start: number;
  end: number;
  depth: number;
  lines: MarkdownInlineNode[][];
}

export type MarkdownBlockKind = "heading" | "paragraph" | "code" | "list" | "quote" | "thematic-break";

export interface MarkdownBlock extends TextBlock {
  markdownKind: MarkdownBlockKind;
  headingLevel?: number;
  inlineNodes?: MarkdownInlineNode[];
  codeText?: string;
  codeStart?: number;
  codeEnd?: number;
  codeLanguage?: string;
  orderedList?: boolean;
  listItems?: MarkdownListItem[];
  quoteLines?: MarkdownInlineNode[][];
}

interface MarkdownLine {
  text: string;
  start: number;
  end: number;
  newlineEnd: number;
}

function readLines(source: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null && match[0]) {
    const raw = match[0];
    const text = raw.replace(/\r?\n$|\r$/, "");
    lines.push({
      text,
      start: match.index,
      end: match.index + text.length,
      newlineEnd: match.index + raw.length,
    });
  }
  return lines;
}

function trimRange(source: string, start: number, end: number): { start: number; end: number } {
  while (start < end && /\s/.test(source[start] ?? "")) start += 1;
  while (end > start && /\s/.test(source[end - 1] ?? "")) end -= 1;
  return { start, end };
}

function safeLinkTarget(value: string): string | undefined {
  const trimmed = value.trim().replace(/^<|>$/g, "");
  if (!trimmed || trimmed.length > 2048) return undefined;
  if (trimmed.startsWith("#")) return trimmed;
  if (/^https?:\/\//iu.test(trimmed)) return trimmed;
  return undefined;
}

function findClosingDelimiter(source: string, delimiter: string, start: number, end: number): number {
  let position = source.indexOf(delimiter, start);
  while (position >= 0 && position < end) {
    if (position === start || source[position - 1] !== "\\") return position;
    position = source.indexOf(delimiter, position + delimiter.length);
  }
  return -1;
}

function findLinkClose(source: string, start: number, end: number): number {
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function parseInlineRange(source: string, start: number, end: number, baseOffset: number): MarkdownInlineNode[] {
  const nodes: MarkdownInlineNode[] = [];
  let plainStart = start;

  const pushPlain = (plainEnd: number) => {
    if (plainEnd <= plainStart) return;
    nodes.push({ type: "text", start: baseOffset + plainStart, end: baseOffset + plainEnd, text: source.slice(plainStart, plainEnd) });
  };

  const pushAndAdvance = (node: MarkdownInlineNode, nodeStart: number, next: number) => {
    pushPlain(nodeStart);
    nodes.push(node);
    plainStart = next;
  };

  let index = start;
  while (index < end) {
    const character = source[index];

    if (character === "\\" && index + 1 < end && /[\\`*_[\]{}()#+.!|>~-]/.test(source[index + 1] ?? "")) {
      pushAndAdvance({ type: "text", start: baseOffset + index, end: baseOffset + index + 2, text: source[index + 1] ?? "" }, index, index + 2);
      index += 2;
      continue;
    }

    if (character === "`") {
      const delimiter = "`";
      const close = findClosingDelimiter(source, delimiter, index + delimiter.length, end);
      if (close > index + delimiter.length) {
        const contentStart = index + delimiter.length;
        const contentEnd = close;
        pushAndAdvance({
          type: "code",
          start: baseOffset + contentStart,
          end: baseOffset + contentEnd,
          text: source.slice(contentStart, contentEnd).replace(/\r?\n|\r/g, " "),
        }, index, close + delimiter.length);
        index = close + delimiter.length;
        continue;
      }
    }

    if (source.startsWith("~~", index)) {
      const close = findClosingDelimiter(source, "~~", index + 2, end);
      if (close > index + 2) {
        pushAndAdvance({
          type: "delete",
          start: baseOffset + index,
          end: baseOffset + close + 2,
          children: parseInlineRange(source, index + 2, close, baseOffset),
        }, index, close + 2);
        index = close + 2;
        continue;
      }
    }

    if (character === "!" && source[index + 1] === "[" || character === "[") {
      const image = character === "!";
      const labelStart = index + (image ? 2 : 1);
      const closeBracket = source.indexOf("]", labelStart);
      if (closeBracket > labelStart && closeBracket + 1 < end && source[closeBracket + 1] === "(") {
        const closeParen = findLinkClose(source, closeBracket + 2, end);
        if (closeParen > closeBracket + 2 && closeParen < end) {
          const rawTarget = source.slice(closeBracket + 2, closeParen).trim();
          const href = safeLinkTarget(rawTarget);
          if (image) {
            pushAndAdvance({
              type: "image",
              start: baseOffset + index,
              end: baseOffset + closeParen + 1,
              alt: source.slice(labelStart, closeBracket),
              altStart: baseOffset + labelStart,
              altEnd: baseOffset + closeBracket,
            }, index, closeParen + 1);
          } else if (href) {
            pushAndAdvance({
              type: "link",
              start: baseOffset + index,
              end: baseOffset + closeParen + 1,
              href,
              children: parseInlineRange(source, labelStart, closeBracket, baseOffset),
            }, index, closeParen + 1);
          } else {
            const labelNodes = parseInlineRange(source, labelStart, closeBracket, baseOffset);
            pushPlain(index);
            nodes.push(...labelNodes);
            plainStart = closeParen + 1;
          }
          index = closeParen + 1;
          continue;
        }
      }
    }

    if (character === "<") {
      const close = source.indexOf(">", index + 1);
      const target = close > index ? safeLinkTarget(source.slice(index + 1, close)) : undefined;
      if (target && /^https?:\/\//iu.test(target)) {
        pushAndAdvance({
          type: "link",
          start: baseOffset + index,
          end: baseOffset + close + 1,
          href: target,
          children: [{ type: "text", start: baseOffset + index + 1, end: baseOffset + close, text: source.slice(index + 1, close) }],
        }, index, close + 1);
        index = close + 1;
        continue;
      }
    }

    const delimiter = source.startsWith("**", index) || source.startsWith("__", index)
      ? source.slice(index, index + 2)
      : source.startsWith("*", index) || source.startsWith("_", index)
        ? source[index] ?? ""
        : "";
    if (delimiter && (delimiter !== "_" || index === start || !/\w/u.test(source[index - 1] ?? ""))) {
      const close = findClosingDelimiter(source, delimiter, index + delimiter.length, end);
      if (close > index + delimiter.length) {
        pushAndAdvance({
          type: delimiter.length === 2 ? "strong" : "emphasis",
          start: baseOffset + index,
          end: baseOffset + close + delimiter.length,
          children: parseInlineRange(source, index + delimiter.length, close, baseOffset),
        }, index, close + delimiter.length);
        index = close + delimiter.length;
        continue;
      }
    }

    if (source.startsWith("  ", index)) {
      const lineBreakLength = source[index + 2] === "\r" && source[index + 3] === "\n" ? 4 : source[index + 2] === "\r" || source[index + 2] === "\n" ? 3 : 0;
      if (lineBreakLength > 0) {
        pushAndAdvance({ type: "break", start: baseOffset + index, end: baseOffset + index + lineBreakLength }, index, index + lineBreakLength);
        index += lineBreakLength;
        continue;
      }
    }

    index += 1;
  }

  pushPlain(end);
  return nodes;
}

export function parseMarkdownInline(source: string, baseOffset = 0): MarkdownInlineNode[] {
  return parseInlineRange(source, 0, source.length, baseOffset);
}

function parseList(lines: MarkdownLine[], baseOffset: number): { ordered: boolean; items: MarkdownListItem[] } | undefined {
  const first = /^([ \t]*)([-+*]|\d+[.)])(?:[ \t]+(.*)|$)/.exec(lines[0]?.text ?? "");
  if (!first) return undefined;
  const ordered = /^\d/u.test(first[2] ?? "");
  const items: MarkdownListItem[] = [];
  let current: MarkdownListItem | undefined;

  for (const line of lines) {
    const match = /^([ \t]*)([-+*]|\d+[.)])(?:[ \t]+(.*)|$)/.exec(line.text);
    if (match) {
      const itemOrdered = /^\d/u.test(match[2] ?? "");
      if (itemOrdered !== ordered) return undefined;
      const content = match[3] ?? "";
      const contentStart = line.start + (match[0].length - content.length);
      current = {
        start: baseOffset + line.start,
        end: baseOffset + line.end,
        depth: Math.floor((match[1]?.replace(/\t/g, "    ").length ?? 0) / 2),
        lines: [parseInlineRange(line.text, contentStart - line.start, line.text.length, baseOffset + line.start)],
      };
      items.push(current);
      continue;
    }
    if (!current || !line.text.trim() || !/^[ \t]+/.test(line.text)) return undefined;
    const contentStart = line.start + line.text.search(/\S/u);
    current.end = baseOffset + line.end;
    current.lines.push(parseInlineRange(line.text, contentStart - line.start, line.text.length, baseOffset + line.start));
  }

  return items.length > 0 ? { ordered, items } : undefined;
}

function parseQuote(lines: MarkdownLine[], baseOffset: number): MarkdownInlineNode[][] | undefined {
  if (!lines.every((line) => /^ {0,3}> ?/.test(line.text))) return undefined;
  return lines.map((line) => {
    const prefix = /^ {0,3}> ?/.exec(line.text)?.[0] ?? "";
    return parseInlineRange(line.text, prefix.length, line.text.length, baseOffset + line.start);
  });
}

function headingContent(source: string, line: MarkdownLine, markerLength: number, baseOffset: number): MarkdownInlineNode[] {
  const contentStart = markerLength;
  const rawContentEnd = line.end;
  let start = contentStart;
  while (start < rawContentEnd && /[ \t]/.test(source[start] ?? "")) start += 1;
  let end = rawContentEnd;
  const closing = /[ \t]+#+[ \t]*$/u.exec(source.slice(start, rawContentEnd));
  if (closing) end -= closing[0].length;
  const range = trimRange(source, start, end);
  return parseInlineRange(source, range.start, range.end, baseOffset);
}

export function parseMarkdownBlock(block: TextBlock): MarkdownBlock {
  const source = block.text;
  const lines = readLines(source);
  const first = lines[0];
  if (!first) return { ...block, markdownKind: "paragraph", inlineNodes: [] };

  const fence = /^ {0,3}(`{3,}|~{3,})([^`]*)$/u.exec(first.text);
  if (fence) {
    const marker = fence[1]!.startsWith("`") ? "`" : "~";
    const closingIndex = lines.findIndex((line, index) => index > 0 && new RegExp(`^ {0,3}${marker}{${fence[1]!.length},}[ \\t]*$`, "u").test(line.text));
    const closing = closingIndex >= 0 ? lines[closingIndex] : undefined;
    const codeStart = first.newlineEnd;
    const codeEnd = closing?.start ?? source.length;
    const language = fence[2]?.trim().split(/[ \t]+/, 1)[0]?.replace(/[^a-z0-9_-]/giu, "").slice(0, 24) || undefined;
    return {
      ...block,
      kind: "code",
      markdownKind: "code",
      codeText: source.slice(codeStart, codeEnd),
      codeStart: block.start + codeStart,
      codeEnd: block.start + codeEnd,
      codeLanguage: language,
    };
  }

  const atx = /^( {0,3})(#{1,6})(?:[ \t]+(.*)|$)/u.exec(first.text);
  if (atx && (atx[3] ?? "").trim()) {
    return {
      ...block,
      kind: "heading",
      markdownKind: "heading",
      headingLevel: atx[2]!.length,
      inlineNodes: headingContent(source, first, atx[1]!.length + atx[2]!.length, block.start),
    };
  }

  const setext = lines.length >= 2 && lines[0]!.text.trim() && /^ {0,3}(=+|-+)[ \t]*$/u.test(lines[1]!.text);
  if (setext) {
    const range = trimRange(source, first.start, first.end);
    return {
      ...block,
      kind: "heading",
      markdownKind: "heading",
      headingLevel: lines[1]!.text.trim().startsWith("=") ? 1 : 2,
      inlineNodes: parseInlineRange(source, range.start, range.end, block.start),
    };
  }

  if (/^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/u.test(first.text)) {
    return { ...block, markdownKind: "thematic-break" };
  }

  const list = parseList(lines, block.start);
  if (list) return { ...block, markdownKind: "list", orderedList: list.ordered, listItems: list.items };

  const quoteLines = parseQuote(lines, block.start);
  if (quoteLines) return { ...block, markdownKind: "quote", quoteLines };

  return { ...block, markdownKind: "paragraph", inlineNodes: parseInlineRange(source, 0, source.length, block.start) };
}
