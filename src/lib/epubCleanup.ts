interface EpubDisposableView extends EventTarget {
  book?: { destroy?: () => void };
  close: () => void;
  remove: () => void;
}

interface EpubDisposerOptions {
  view: EpubDisposableView;
  documents: Iterable<EventTarget | null | undefined>;
  keydownHandler: EventListener;
  viewListeners: Array<{ type: string; handler: EventListener }>;
  report?: (error: unknown) => void;
}

export function createEpubDisposer({
  view,
  documents,
  keydownHandler,
  viewListeners,
  report = (error) => console.error("Failed to release an EPUB resource.", error),
}: EpubDisposerOptions): () => void {
  let disposed = false;

  return () => {
    if (disposed) return;
    disposed = true;

    const attempt = (action: () => void) => {
      try {
        action();
      } catch (error) {
        report(error);
      }
    };

    for (const document of documents) {
      if (document) attempt(() => document.removeEventListener("keydown", keydownHandler));
    }
    for (const { type, handler } of viewListeners) {
      attempt(() => view.removeEventListener(type, handler));
    }

    const book = view.book;
    attempt(() => view.close());
    if (book?.destroy) attempt(() => book.destroy?.());
    attempt(() => view.remove());
  };
}
