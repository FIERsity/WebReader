import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FEEDBACK_LENGTH, submitFeedback } from "./feedback";

afterEach(() => vi.unstubAllGlobals());

describe("submitFeedback", () => {
  it("sends only marked feedback text to the feedback server", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await submitFeedback("  阅读体验很好  ", "zh");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ text: "阅读体验很好", product: "WebReader", language: "zh" });
  });

  it("rejects empty or oversized feedback before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitFeedback("   ", "en")).rejects.toThrow(/1-2000/);
    await expect(submitFeedback("x".repeat(MAX_FEEDBACK_LENGTH + 1), "en")).rejects.toThrow(/1-2000/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a failed server response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 429 })));
    await expect(submitFeedback("test", "en")).rejects.toThrow(/HTTP 429/);
  });
});
