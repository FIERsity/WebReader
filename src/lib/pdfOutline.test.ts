import { describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getPdfOutline } from "./pdfOutline";

function proxy(): PDFDocumentProxy {
  return {
    getOutline: vi.fn().mockResolvedValue([
      { title: "Named", dest: "chapter", url: null, items: [] },
      { title: "Nested", dest: null, url: null, items: [
        { title: "Direct", dest: [{ num: 9, gen: 0 }], url: null, items: [] },
      ] },
      { title: "External", dest: null, url: "https://example.com", items: [] },
    ]),
    getDestination: vi.fn().mockResolvedValue([2]),
    getPageIndex: vi.fn().mockResolvedValue(4),
  } as unknown as PDFDocumentProxy;
}

describe("PDF outline", () => {
  it("resolves named and referenced destinations without exposing external links", async () => {
    expect(await getPdfOutline(proxy())).toEqual([
      { id: "pdf-0", label: "Named", target: "3", children: [] },
      { id: "pdf-1", label: "Nested", target: undefined, children: [
        { id: "pdf-1-0", label: "Direct", target: "5", children: [] },
      ] },
      { id: "pdf-2", label: "External", target: undefined, children: [] },
    ]);
  });
});
