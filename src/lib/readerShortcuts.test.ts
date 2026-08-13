import { describe, expect, it, vi } from "vitest";
import { handleReaderShortcut } from "./readerShortcuts";

function keyboard(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return {
    key,
    defaultPrevented: false,
    isComposing: Boolean(init.isComposing),
    ctrlKey: Boolean(init.ctrlKey),
    altKey: Boolean(init.altKey),
    metaKey: Boolean(init.metaKey),
    shiftKey: Boolean(init.shiftKey),
    target: null,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

function actions(typography = true) {
  return {
    previous: vi.fn(), next: vi.fn(), decreaseText: vi.fn(), increaseText: vi.fn(),
    toggleOutline: vi.fn(), closePanel: vi.fn(), typography,
  };
}

describe("reader shortcuts", () => {
  it("maps page and panel commands", () => {
    const handlers = actions();
    expect(handleReaderShortcut(keyboard("ArrowRight"), handlers)).toBe(true);
    expect(handleReaderShortcut(keyboard(" ", { shiftKey: true }), handlers)).toBe(true);
    expect(handleReaderShortcut(keyboard("t"), handlers)).toBe(true);
    expect(handlers.next).toHaveBeenCalledOnce();
    expect(handlers.previous).toHaveBeenCalledOnce();
    expect(handlers.toggleOutline).toHaveBeenCalledOnce();
  });

  it("does not change text size for fixed-layout content", () => {
    const handlers = actions(false);
    expect(handleReaderShortcut(keyboard("]"), handlers)).toBe(false);
    expect(handlers.increaseText).not.toHaveBeenCalled();
  });

  it("does not intercept shortcuts while a control owns focus, except Escape", () => {
    const handlers = actions();
    const textSize = keyboard("]");
    Object.defineProperty(textSize, "target", { value: { closest: () => ({}) } });
    expect(handleReaderShortcut(textSize, handlers)).toBe(false);
    expect(handlers.increaseText).not.toHaveBeenCalled();

    const escape = keyboard("Escape");
    Object.defineProperty(escape, "target", { value: { closest: () => ({}) } });
    expect(handleReaderShortcut(escape, handlers)).toBe(true);
    expect(handlers.closePanel).toHaveBeenCalledOnce();
  });

  it("ignores modified shortcuts and composition", () => {
    const handlers = actions();
    expect(handleReaderShortcut(keyboard("ArrowRight", { ctrlKey: true }), handlers)).toBe(false);
    expect(handleReaderShortcut(keyboard("ArrowRight", { isComposing: true }), handlers)).toBe(false);
    expect(handlers.next).not.toHaveBeenCalled();
  });
});
