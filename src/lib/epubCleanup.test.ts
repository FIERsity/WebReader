import { describe, expect, it, vi } from "vitest";
import { createEpubDisposer } from "./epubCleanup";

class FakeTarget extends EventTarget {
  remove = vi.fn();
}

describe("EPUB cleanup", () => {
  it("ignores missing documents and releases resources only once", () => {
    const view = new FakeTarget() as FakeTarget & { close: () => void; book: { destroy: () => void } };
    view.close = vi.fn();
    view.book = { destroy: vi.fn() };
    const document = new EventTarget();
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const handler = vi.fn();
    const dispose = createEpubDisposer({
      view,
      documents: [document, null, undefined],
      keydownHandler: handler,
      viewListeners: [{ type: "load", handler }],
      report: vi.fn(),
    });

    dispose();
    dispose();

    expect(removeDocumentListener).toHaveBeenCalledOnce();
    expect(view.close).toHaveBeenCalledOnce();
    expect(view.book.destroy).toHaveBeenCalledOnce();
    expect(view.remove).toHaveBeenCalledOnce();
  });

  it("continues releasing resources when a third-party close throws", () => {
    const report = vi.fn();
    const remove = vi.fn();
    const destroy = vi.fn();
    const view = Object.assign(new EventTarget(), {
      close: vi.fn(() => { throw new Error("close failed"); }),
      remove,
      book: { destroy },
    });
    const dispose = createEpubDisposer({
      view,
      documents: [],
      keydownHandler: vi.fn(),
      viewListeners: [],
      report,
    });

    expect(dispose).not.toThrow();
    expect(report).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });
});
