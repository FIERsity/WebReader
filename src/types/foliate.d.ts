declare module "foliate-js/view.js";

declare global {
  interface FoliateBookMetadata {
    title?: string | Record<string, string>;
    author?: string | { name?: string } | Array<string | { name?: string }>;
  }

  interface FoliateTocItem {
    label?: string;
    href?: string | null;
    subitems?: FoliateTocItem[] | null;
  }

  interface FoliateViewElement extends HTMLElement {
    book?: {
      metadata?: FoliateBookMetadata;
      toc?: FoliateTocItem[];
      rendition?: { layout?: string };
      destroy?: () => void;
    };
    renderer?: HTMLElement & {
      setStyles?: (styles: string) => void;
      setAttribute: (name: string, value: string) => void;
      getContents?: () => Array<{ doc: Document }>;
    };
    open: (file: Blob) => Promise<void>;
    init: (options: { lastLocation?: string; showTextStart?: boolean }) => Promise<void>;
    close: () => void;
    goLeft: () => Promise<void>;
    goRight: () => Promise<void>;
    prev: () => Promise<void>;
    next: () => Promise<void>;
    goTo: (target: string | number | { fraction: number }) => Promise<unknown>;
  }

  interface HTMLElementTagNameMap {
    "foliate-view": FoliateViewElement;
  }
}

export {};
