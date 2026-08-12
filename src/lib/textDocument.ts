import type { ReaderOutlineItem } from "../types/reader";

export interface TextBlock {
  id: string;
  start: number;
  text: string;
}

const CHAPTER_PATTERN = /^\s*(第\s*[〇零一二三四五六七八九十百千0-9]+\s*[章节回卷部篇]|chapter\s+[\divxlcdm]+\b)/i;

export function splitTextBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const pattern = /[^\r\n](?:[^\r\n]|(?:\r?\n)(?![ \t]*\r?\n))*/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[0].trimEnd();
    if (value.trim()) {
      blocks.push({ id: `text-${index}`, start: match.index, text: value });
      index += 1;
    }
  }
  return blocks;
}

export function extractMarkdownOutline(text: string): ReaderOutlineItem[] {
  const items: ReaderOutlineItem[] = [];
  const stack: Array<{ level: number; item: ReaderOutlineItem }> = [];
  const lines: Array<{ text: string; start: number }> = [];
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && match[0]) {
    lines.push({ text: match[0].replace(/\r?\n$|\r$/, ""), start: match.index });
  }
  let fenced = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineEntry = lines[index]!;
    const line = lineEntry.text;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const next = lines[index + 1]?.text ?? "";
    const setext = line.trim() && /^(=+|-+)\s*$/.exec(next);
    const level = atx?.[1]?.length ?? (setext ? (next.trim().startsWith("=") ? 1 : 2) : 0);
    const label = (atx?.[2] ?? (setext ? line : "")).trim();
    if (level && label) {
      const item: ReaderOutlineItem = {
        id: `markdown-${lineEntry.start}`,
        label,
        target: String(lineEntry.start),
        children: [],
      };
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      const parent = stack[stack.length - 1]?.item;
      (parent ? parent.children : items).push(item);
      stack.push({ level, item });
    }
  }
  return items;
}

export function extractTextOutline(text: string): ReaderOutlineItem[] {
  return splitTextBlocks(text)
    .filter((block) => CHAPTER_PATTERN.test(block.text.split("\n", 1)[0] ?? ""))
    .map((block) => ({
      id: `chapter-${block.start}`,
      label: (block.text.split("\n", 1)[0] ?? "").trim(),
      target: String(block.start),
      children: [],
    }));
}
