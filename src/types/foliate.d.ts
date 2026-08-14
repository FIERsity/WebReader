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
      sections?: Array<{ createDocument?: () => Promise<Document> | Document }>;
      destroy?: () => void;
    };
    renderer?: HTMLElement & {
      scrolled: boolean;
      size: number;
      viewSize: number;
      start: number;
      end: number;
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
    search: (options: { query: string; index?: number }) => AsyncGenerator<
      | string
      | { progress: number }
      | { cfi: string; excerpt: { pre: string; match: string; post: string } }
      | { label: string; subitems: Array<{ cfi: string; excerpt: { pre: string; match: string; post: string } }> }
    >;
    clearSearch: () => void;
    addAnnotation: (annotation: { value: string }) => Promise<unknown>;
    deleteAnnotation: (annotation: { value: string }) => Promise<unknown>;
  }

  interface HTMLElementTagNameMap {
    "foliate-view": FoliateViewElement;
  }
}

export {};
