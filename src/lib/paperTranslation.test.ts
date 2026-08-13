import { describe, expect, it, vi } from "vitest";
import {
  createPaperBatches, MAX_PAPER_BATCH_CHARACTERS, providerDefaultEndpoint,
  translatePaperBatchDirect, translatePaperBatchRecovering, validatePaperProviderConfig,
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
    expect(validatePaperProviderConfig({ provider: "deepseek", model: "deepseek-v4-pro", apiKey: "key" }).hostname).toBe("api.deepseek.com");
    expect(() => validatePaperProviderConfig({ provider: "deepseek", model: "deepseek-chat", apiKey: "key" })).toThrow(/retired/);
    expect(() => validatePaperProviderConfig({
      provider: "openai", model: "model", apiKey: "key", endpoint: "https://attacker.example/v1/responses",
    })).toThrow(/cannot be changed/);
    expect(() => validatePaperProviderConfig({
      provider: "custom-openai", model: "model", apiKey: "key", endpoint: "http://localhost:8000/v1/chat/completions",
    })).toThrow(/HTTPS/);
  });

  it("uses explicit output budgets and ASCII protected tokens", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        max_tokens?: number; thinking?: { type?: string }; messages?: Array<{ content: string }>;
      };
      const payload = JSON.parse(request.messages?.[1]?.content ?? "{}") as { units: Array<{ id: string; text: string }> };
      const protectedText = payload.units[0]!.text;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ units: [{ id: "a", text: `已翻译 ${protectedText}` }] }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const result = await translatePaperBatchDirect({
        config: { provider: "deepseek", model: "deepseek-v4-pro", apiKey: "memory-only" },
        targetLanguage: "zh-CN",
        units: [unit("a", "See https://example.com and [12].")],
        context: "",
        signal: new AbortController().signal,
      });
      expect(result.get("a")).toContain("https://example.com");
      const request = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(request.max_tokens).toBe(8192);
      expect(request.thinking).toEqual({ type: "disabled" });
      expect(request.messages[1].content).toMatch(/__WRP_[A-Za-z0-9_]+__/u);
      expect(request.messages[1].content).not.toContain("⟦");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts a complete JSON object wrapped in provider commentary", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Translation follows:\n{\"units\":[{\"id\":\"a\",\"text\":\"完成 {含括号}\"}]}\nDone." } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const result = await translatePaperBatchDirect({
        config: { provider: "deepseek", model: "deepseek-v4-pro", apiKey: "memory-only" },
        targetLanguage: "zh-CN", units: [unit("a", "Complete")], context: "",
        signal: new AbortController().signal,
      });
      expect(result.get("a")).toBe("完成 {含括号}");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("selects the complete translation object when commentary contains other JSON", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Metadata: {\"status\":\"ok\"}\nTranslation: {\"units\":[{\"id\":\"a\",\"text\":\"完整译文\"}]}" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const result = await translatePaperBatchDirect({
        config: { provider: "deepseek", model: "deepseek-v4-pro", apiKey: "memory-only" },
        targetLanguage: "zh-CN", units: [unit("a", "Complete")], context: "",
        signal: new AbortController().signal,
      });
      expect(result.get("a")).toBe("完整译文");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not send DeepSeek-only output parameters to a custom endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).not.toHaveProperty("max_tokens");
      expect(request).not.toHaveProperty("thinking");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ units: [{ id: "a", text: "complete" }] }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await translatePaperBatchDirect({
        config: {
          provider: "custom-openai", model: "custom-model", apiKey: "memory-only",
          endpoint: "https://models.example/v1/chat/completions",
        },
        targetLanguage: "en", units: [unit("a", "Complete")], context: "",
        signal: new AbortController().signal,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("splits invalid multi-unit output and retries a failing single unit once", async () => {
    const calls: string[][] = [];
    const attempts = new Map<string, number>();
    const translator = vi.fn(async ({ units }: { units: PaperTranslationUnit[] }) => {
      calls.push(units.map((entry) => entry.id));
      if (units.length > 1) throw Object.assign(new Error("omitted"), { code: "invalid-output" });
      const id = units[0]!.id;
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (id === "b" && attempt === 1) throw Object.assign(new Error("placeholder changed"), { code: "invalid-output" });
      return new Map([[id, `translated-${id}`]]);
    });
    const result = await translatePaperBatchRecovering({
      config: { provider: "deepseek", model: "deepseek-v4-pro", apiKey: "memory-only" },
      targetLanguage: "zh-CN",
      units: [unit("a", "one"), unit("b", "two"), unit("c", "three"), unit("d", "four")],
      context: "section",
      signal: new AbortController().signal,
    }, translator);
    expect([...result]).toEqual([
      ["a", "translated-a"], ["b", "translated-b"], ["c", "translated-c"], ["d", "translated-d"],
    ]);
    expect(calls).toContainEqual(["a", "b", "c", "d"]);
    expect(calls.filter((ids) => ids.length === 1 && ids[0] === "b")).toHaveLength(2);
  });

  it("rejects responses that omit ids or alter protected source tokens", async () => {
    const originalFetch = globalThis.fetch;
    let responseText = "已翻译，引用已删除";
    globalThis.fetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages?: Array<{ content: string }> };
      const payload = JSON.parse(request.messages?.[1]?.content ?? "{}") as { units: Array<{ text: string }> };
      const token = payload.units[0]!.text.match(/__WRP_[A-Za-z0-9_]+__/u)?.[0];
      const text = responseText === "boundary" && token ? `已翻译 _${token}_` : responseText;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ units: [{ id: "a", text }] }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const input = {
        config: { provider: "deepseek", model: "deepseek-v4-pro", apiKey: "memory-only" } as const,
        targetLanguage: "zh-CN" as const,
        units: [unit("a", "See https://example.com and [12].")], context: "",
        signal: new AbortController().signal,
      };
      await expect(translatePaperBatchDirect(input)).rejects.toMatchObject({ code: "invalid-output" });
      responseText = "boundary";
      await expect(translatePaperBatchDirect(input)).rejects.toMatchObject({ code: "invalid-output" });
      expect(JSON.stringify((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls)).toContain("memory-only");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
