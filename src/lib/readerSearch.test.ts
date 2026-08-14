import { describe, expect, it } from "vitest";
import { findTextMatches, MAX_SEARCH_QUERY_LENGTH, throwIfSearchAborted } from "./readerSearch";

describe("reader search", () => {
  it("finds case-insensitive matches with stable offsets and excerpts", () => {
    const outcome = findTextMatches("Before WebReader after. WEBREADER again.", "webreader");
    expect(outcome.results.map((result) => [result.start, result.end, result.excerpt.match])).toEqual([
      [7, 16, "WebReader"],
      [24, 33, "WEBREADER"],
    ]);
    expect(outcome.truncated).toBe(false);
  });

  it("bounds query and result growth", () => {
    expect(findTextMatches("x ".repeat(12), "x", { maxResults: 3 })).toMatchObject({
      results: [{ start: 0 }, { start: 2 }, { start: 4 }],
      truncated: true,
    });
    expect(findTextMatches("a".repeat(MAX_SEARCH_QUERY_LENGTH + 20), "a".repeat(MAX_SEARCH_QUERY_LENGTH + 20)).results).toHaveLength(1);
  });

  it("treats punctuation as literal text", () => {
    expect(findTextMatches("Use [local] (search).", "[local] (search).").results[0]).toMatchObject({
      start: 4,
      excerpt: { match: "[local] (search)." },
    });
  });

  it("honors cancellation", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfSearchAborted(controller.signal)).toThrowError(/cancelled/i);
  });
});
