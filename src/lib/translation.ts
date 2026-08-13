import type {
  TranslationAnchor, TranslationCacheRecord, TranslationRequest, TranslationResponse,
  TranslationTargetLanguage,
} from "../types/translation.js";

export const TRANSLATION_PROVIDER = "deepseek" as const;
export const TRANSLATION_MODEL = "deepseek-chat" as const;
export const TRANSLATION_PROMPT_VERSION = "translate-v1" as const;
export const MAX_TRANSLATION_CHARACTERS = 12_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashText(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export function normalizeTranslationAnchor(anchor: TranslationAnchor, textLength: number): TranslationAnchor {
  const start = Math.max(0, Math.min(textLength, Math.trunc(anchor.start)));
  const end = Math.max(start, Math.min(textLength, Math.trunc(anchor.end)));
  if (end <= start) throw new Error("The translation selection is empty.");
  return { ...anchor, start, end };
}

export async function createTranslationCacheRecord(input: {
  bookId: string;
  documentRevision: string;
  blockId: string;
  blockText: string;
  start?: number;
  end?: number;
  targetLanguage: TranslationTargetLanguage;
  translatedText: string;
  now?: number;
}): Promise<TranslationCacheRecord> {
  const anchor = normalizeTranslationAnchor({
    blockId: input.blockId,
    start: input.start ?? 0,
    end: input.end ?? input.blockText.length,
  }, input.blockText.length);
  const sourceText = input.blockText.slice(anchor.start, anchor.end);
  const sourceHash = await hashText(sourceText);
  const identity = [
    input.bookId, input.documentRevision, sourceHash, anchor.blockId, anchor.start, anchor.end,
    input.targetLanguage, TRANSLATION_PROVIDER, TRANSLATION_MODEL, TRANSLATION_PROMPT_VERSION,
  ].join("\u0000");
  const now = input.now ?? Date.now();
  return {
    key: await hashText(identity),
    bookId: input.bookId,
    documentRevision: input.documentRevision,
    sourceHash,
    anchor,
    targetLanguage: input.targetLanguage,
    provider: TRANSLATION_PROVIDER,
    model: TRANSLATION_MODEL,
    promptVersion: TRANSLATION_PROMPT_VERSION,
    translatedText: input.translatedText,
    createdAt: now,
    updatedAt: now,
  };
}

export async function translationCacheKey(input: Omit<Parameters<typeof createTranslationCacheRecord>[0], "translatedText" | "now">): Promise<string> {
  return (await createTranslationCacheRecord({ ...input, translatedText: "", now: 0 })).key;
}

export function buildTranslationRequest(id: string, text: string, targetLanguage: TranslationTargetLanguage): TranslationRequest {
  const value = text.trim();
  if (!value || value.length > MAX_TRANSLATION_CHARACTERS) throw new Error("The translation unit has an invalid length.");
  return { version: 1, unit: { id, text: value, sourceLanguage: "auto" }, targetLanguage };
}

export function parseTranslationResponse(value: unknown, expectedId: string): TranslationResponse {
  if (!value || typeof value !== "object") throw new Error("The translation response is invalid.");
  const response = value as Partial<TranslationResponse>;
  if (response.version !== 1 || response.provider !== TRANSLATION_PROVIDER
    || response.model !== TRANSLATION_MODEL || response.promptVersion !== TRANSLATION_PROMPT_VERSION
    || !response.translation || response.translation.id !== expectedId
    || typeof response.translation.text !== "string" || !response.translation.text.trim()) {
    throw new Error("The translation response is invalid.");
  }
  return response as TranslationResponse;
}

export async function requestTranslation(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResponse> {
  const response = await fetch("/__webreader/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Translation failed.");
  return parseTranslationResponse(await response.json(), request.unit.id);
}
