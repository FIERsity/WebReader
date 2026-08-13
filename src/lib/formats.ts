import type { BookFormat } from "../types/library";
import type { TranslationKey } from "./i18n";

export const MAX_FILE_SIZE = 250 * 1024 * 1024;
export const MAX_TEXT_FILE_SIZE = 8 * 1024 * 1024;

const EPUB_MIME = "application/epub+zip";
const PDF_MIME = "application/pdf";
const TEXT_MIMES = new Set(["text/plain", "text/markdown"]);

export class BookFormatError extends Error {
  readonly translationKey: TranslationKey;

  constructor(translationKey: TranslationKey) {
    super(translationKey);
    this.translationKey = translationKey;
  }
}

export async function detectBookFormat(file: File): Promise<BookFormat> {
  if (file.size === 0) throw new BookFormatError("emptyFile");
  if (file.size > MAX_FILE_SIZE) {
    throw new BookFormatError("fileTooLarge");
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  const textHint = TEXT_MIMES.has(file.type) || extension === "txt" || extension === "md";
  if (textHint && file.size > MAX_TEXT_FILE_SIZE) throw new BookFormatError("textFileTooLarge");
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isPdf = String.fromCharCode(...head.slice(0, 5)) === "%PDF-";
  const isZip = head[0] === 0x50 && head[1] === 0x4b
    && ((head[2] === 0x03 && head[3] === 0x04)
      || (head[2] === 0x05 && head[3] === 0x06)
      || (head[2] === 0x07 && head[3] === 0x08));

  if (isPdf && (file.type === PDF_MIME || extension === "pdf")) return "pdf";
  if (isZip && (file.type === EPUB_MIME || extension === "epub")) return "epub";
  if (textHint) return "txt";

  throw new BookFormatError("unsupportedFormat");
}

export function displayTitle(fileName: string): string {
  return fileName.replace(/\.(epub|pdf|txt|md)$/i, "").replace(/[_-]+/g, " ").trim()
    || "Untitled";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}
