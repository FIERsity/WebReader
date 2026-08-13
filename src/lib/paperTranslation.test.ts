import { describe, expect, it, vi } from "vitest";
import {
  createPaperBatches, MAX_PAPER_BATCH_CHARACTERS, providerDefaultEndpoint,
  translatePaperBatchDirect, validatePaperProviderConfig,
} from "./paperTranslation";
import type { PaperTranslationUnit } from "../types/translation";

function unit(id: string, text: string): PaperTranslationUnit {
  return { id, text, kind: "paragraph", section: "Methods" };
}

describe("paper translation protocol", () => {
  it("batches complete display units without splitting or reordering them", () => {
    const units = [unit("a", "A".repeat(MAX_PAPER_BATCH_CHARACTERS - 10)), unit("b", "B".repeat(20)), unit("c", "short")];
    const batches = createPaperBatches(units);
    expect(batches.map((batch) => batch.units.map((entry) => entry.id))).toEqual([["a"], ["b", "c"]]);
    expect(batches.flatMap((batch) => batch.units)).toEqual(units);
  });

  it("uses fixed HTTPS endpoints for presets and validates custom endpoints", () => {
    expect(providerDefaultEndpoint("openai")).toBe("https://api.openai.com/v1/responses");
    expect(validatePaperProviderConfig({ provider: "deepseek", model: "deepseek-chat", apiKey: "key" }).hostname).toBe("api.deepseek.com");
    expect(() => validatePaperProviderConfig({
      provider: "openai", model: "model", apiKey: "key", endpoint: "https://attacker.example/v1/responses",
    })).toThrow(/cannot be changed/);
    expect(() => validatePaperProviderConfig({
      provider: "custom-openai", model: "model", apiKey: "key", endpoint: "http://localhost:8000/v1/chat/completions",
    })).toThrow(/HTTPS/);
  });

  it("rejects responses that omit ids or alter protected source tokens", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ units: [{ id: "a", text: "已翻译，引用已删除" }] }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      await expect(translatePaperBatchDirect({
        config: { provider: "deepseek", model: "deepseek-chat", apiKey: "memory-only" },
        targetLanguage: "zh-CN",
        units: [unit("a", "See https://example.com and [12].")],
        context: "",
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: "invalid-output" });
      expect(JSON.stringify((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls)).toContain("memory-only");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
