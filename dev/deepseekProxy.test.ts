import { describe, expect, it, vi } from "vitest";
import { callDeepSeek, isLoopbackAddress, parseProxyRequest } from "./deepseekProxy.js";

const request = {
  version: 1 as const,
  unit: { id: "unit-1", text: "The method is robust.", sourceLanguage: "auto" as const },
  targetLanguage: "zh-CN" as const,
};

describe("DeepSeek development proxy", () => {
  it("accepts only loopback socket addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.12")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("accepts only the bounded fixed request schema", () => {
    expect(parseProxyRequest(request)).toEqual(request);
    expect(() => parseProxyRequest({ ...request, targetLanguage: "fr" })).toThrow("INVALID_REQUEST");
    expect(() => parseProxyRequest({ ...request, unit: { ...request.unit, text: "" } })).toThrow("INVALID_REQUEST");
  });

  it("maps the unit to the fixed provider protocol without exposing the key in output", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-secret-key");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("deepseek-chat");
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.messages[1].content).toContain("The method is robust.");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ id: "unit-1", translation: "该方法很稳健。" }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const response = await callDeepSeek(request, "test-secret-key", fetchMock as typeof fetch);
    expect(response.translation.text).toBe("该方法很稳健。");
    expect(JSON.stringify(response)).not.toContain("test-secret-key");
  });

  it("rejects mismatched or malformed provider output", async () => {
    const mismatched = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ id: "other", translation: "错误" }) } }],
    }), { status: 200 }));
    await expect(callDeepSeek(request, "test-key", mismatched as typeof fetch)).rejects.toThrow("INVALID_RESPONSE");

    const failed = vi.fn(async () => new Response("provider detail must not be surfaced", { status: 429 }));
    await expect(callDeepSeek(request, "test-key", failed as typeof fetch)).rejects.toThrow("UPSTREAM_ERROR");
  });
});
