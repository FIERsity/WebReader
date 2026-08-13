import { describe, expect, it } from "vitest";
import {
  buildTranslationRequest, createTranslationCacheRecord, hashText, normalizeTranslationAnchor,
  parseTranslationResponse, translationCacheKey,
} from "./translation";

const base = {
  bookId: "book-1",
  documentRevision: "revision-1",
  blockId: "paragraph:0:11",
  blockText: "hello world",
  targetLanguage: "zh-CN" as const,
};

describe("translation protocol", () => {
  it("hashes full text deterministically", async () => {
    expect(await hashText("abc")).toBe(await hashText("abc"));
    expect(await hashText("abc")).not.toBe(await hashText("abd"));
  });

  it("normalizes same-block source ranges and rejects empty selections", () => {
    expect(normalizeTranslationAnchor({ blockId: "b", start: -2, end: 20 }, 8)).toEqual({ blockId: "b", start: 0, end: 8 });
    expect(() => normalizeTranslationAnchor({ blockId: "b", start: 4, end: 4 }, 8)).toThrow(/empty/);
  });

  it("isolates cache keys by range, language, revision, and source text", async () => {
    const full = await translationCacheKey(base);
    expect(await translationCacheKey({ ...base, start: 1, end: 5 })).not.toBe(full);
    expect(await translationCacheKey({ ...base, targetLanguage: "en" })).not.toBe(full);
    expect(await translationCacheKey({ ...base, documentRevision: "revision-2" })).not.toBe(full);
    expect(await translationCacheKey({ ...base, blockText: "hello there" })).not.toBe(full);
  });

  it("creates cache records without credential fields", async () => {
    const record = await createTranslationCacheRecord({ ...base, translatedText: "你好，世界", now: 10 });
    expect(record.translatedText).toBe("你好，世界");
    expect(record.createdAt).toBe(10);
    expect(JSON.stringify(record)).not.toMatch(/api.?key|authorization|secret/i);
  });

  it("validates request length and structured responses", () => {
    const request = buildTranslationRequest("unit-1", "Hello", "zh-CN");
    expect(request.unit.text).toBe("Hello");
    expect(() => buildTranslationRequest("unit-1", "", "zh-CN")).toThrow(/length/);
    expect(parseTranslationResponse({
      version: 1,
      translation: { id: "unit-1", text: "你好" },
      provider: "deepseek",
      model: "deepseek-chat",
      promptVersion: "translate-v1",
    }, "unit-1").translation.text).toBe("你好");
    expect(() => parseTranslationResponse({ version: 1 }, "unit-1")).toThrow(/invalid/);
  });
});
