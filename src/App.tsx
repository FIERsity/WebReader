import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen, ChevronLeft, ChevronRight, FileText, Import, Library,
  Moon, Plus, Sun, Trash2, Type, X,
} from "lucide-react";
import "./App.css";
import { detectBookFormat, displayTitle, formatBytes } from "./lib/formats";
import { fingerprintFile } from "./lib/fingerprint";
import {
  findByFingerprint, getBookFile, getPreferences, listBooks, removeBook,
  requestPersistentStorage, saveBook, savePreferences, updateLocator,
} from "./lib/storage";
import type { BookRecord, ReaderPreferences, ReadingLocator } from "./types/library";
import { DEFAULT_PREFERENCES } from "./types/library";

const EpubReader = lazy(() => import("./readers/EpubReader").then((module) => ({ default: module.EpubReader })));
const PdfReader = lazy(() => import("./readers/PdfReader").then((module) => ({ default: module.PdfReader })));
const TextReader = lazy(() => import("./readers/TextReader").then((module) => ({ default: module.TextReader })));

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(timestamp);
}

function formatLabel(format: BookRecord["format"]): string {
  return format === "txt" ? "TEXT" : format.toUpperCase();
}

export default function App() {
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [activeBook, setActiveBook] = useState<BookRecord>();
  const [activeFile, setActiveFile] = useState<Blob>();
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_PREFERENCES);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<BookRecord>();
  const [updateAction, setUpdateAction] = useState<(() => void) | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigationRef = useRef<{ previous: () => void; next: () => void } | null>(null);

  const refreshBooks = useCallback(async () => setBooks(await listBooks()), []);

  useEffect(() => {
    const handleUpdate = (event: Event) => {
      const activate = (event as CustomEvent<() => Promise<void>>).detail;
      setUpdateAction(() => () => void activate());
    };
    window.addEventListener("webreader-update-available", handleUpdate);
    return () => window.removeEventListener("webreader-update-available", handleUpdate);
  }, []);

  useEffect(() => {
    void Promise.all([listBooks(), getPreferences()]).then(([storedBooks, storedPreferences]) => {
      setBooks(storedBooks);
      setPreferences(storedPreferences);
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Local storage is unavailable."));
    void requestPersistentStorage();
  }, []);

  const importFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setMessage(undefined);
    let imported = 0;
    try {
      for (const file of files) {
        const format = await detectBookFormat(file);
        const fingerprint = await fingerprintFile(file);
        const existing = await findByFingerprint(fingerprint);
        if (existing) {
          setMessage(`“${existing.title}” is already in this library.`);
          continue;
        }
        const now = Date.now();
        const book: BookRecord = {
          id: crypto.randomUUID(),
          fingerprint,
          title: displayTitle(file.name),
          format,
          fileName: file.name,
          mediaType: file.type || (format === "txt" ? "text/plain" : `application/${format}`),
          size: file.size,
          addedAt: now,
          updatedAt: now,
        };
        await saveBook(book, file);
        imported += 1;
      }
      await refreshBooks();
      if (imported > 0) setMessage(`${imported} ${imported === 1 ? "book" : "books"} added to this browser.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The selected file could not be imported.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [refreshBooks]);

  const openBook = useCallback(async (book: BookRecord) => {
    setMessage(undefined);
    try {
      const file = await getBookFile(book.id);
      setActiveFile(file);
      setActiveBook(book);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The book could not be opened.");
    }
  }, []);

  const closeReader = useCallback(async () => {
    setActiveBook(undefined);
    setActiveFile(undefined);
    await refreshBooks();
  }, [refreshBooks]);

  const handleProgress = useCallback((locator: ReadingLocator) => {
    if (!activeBook) return;
    void updateLocator(activeBook.id, locator);
  }, [activeBook]);

  const updatePreferences = useCallback((next: ReaderPreferences) => {
    setPreferences(next);
    void savePreferences(next);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    await removeBook(deleteTarget.id);
    setDeleteTarget(undefined);
    await refreshBooks();
  }, [deleteTarget, refreshBooks]);

  if (activeBook && activeFile) {
    return (
      <main className={`reader-shell theme-${preferences.theme}`}>
        <header className="reader-toolbar">
          <button className="icon-button" type="button" onClick={() => void closeReader()} title="Back to library" aria-label="Back to library">
            <ChevronLeft />
          </button>
          <div className="reader-title">
            <strong>{activeBook.title}</strong>
            <span>{activeBook.locator?.label ?? formatLabel(activeBook.format)}</span>
          </div>
          <div className="reader-controls">
            {activeBook.format !== "pdf" && (
              <label className="compact-control" title="Text size">
                <Type aria-hidden="true" />
                <input
                  aria-label="Text size"
                  type="range"
                  min="0.8"
                  max="1.5"
                  step="0.1"
                  value={preferences.fontScale}
                  onChange={(event) => updatePreferences({ ...preferences, fontScale: Number(event.target.value) })}
                />
              </label>
            )}
            <button
              className="icon-button"
              type="button"
              title={preferences.theme === "night" ? "Use paper theme" : "Use night theme"}
              aria-label={preferences.theme === "night" ? "Use paper theme" : "Use night theme"}
              onClick={() => updatePreferences({ ...preferences, theme: preferences.theme === "night" ? "paper" : "night" })}
            >
              {preferences.theme === "night" ? <Sun /> : <Moon />}
            </button>
          </div>
        </header>
        <section className="reading-surface">
          <Suspense fallback={<div className="reader-loading">Preparing book...</div>}>
            {activeBook.format === "epub" && (
              <EpubReader file={activeFile} locator={activeBook.locator} preferences={preferences} onProgress={handleProgress} navigationRef={navigationRef} />
            )}
            {activeBook.format === "pdf" && (
              <PdfReader file={activeFile} locator={activeBook.locator} preferences={preferences} onProgress={handleProgress} navigationRef={navigationRef} />
            )}
            {activeBook.format === "txt" && (
              <TextReader file={activeFile} locator={activeBook.locator} preferences={preferences} onProgress={handleProgress} navigationRef={navigationRef} />
            )}
          </Suspense>
          <button className="page-turn page-turn-left" type="button" onClick={() => navigationRef.current?.previous()} aria-label="Previous page"><ChevronLeft /></button>
          <button className="page-turn page-turn-right" type="button" onClick={() => navigationRef.current?.next()} aria-label="Next page"><ChevronRight /></button>
        </section>
      </main>
    );
  }

  return (
    <main className="library-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><BookOpen /></span><span>WebReader</span></div>
        <nav aria-label="Library sections">
          <button className="nav-item active" type="button"><Library />Library <span>{books.length}</span></button>
        </nav>
        <div className="privacy-note">
          <strong>Private by default</strong>
          <span>Books stay in this browser and are never sent to GitHub.</span>
        </div>
      </aside>

      <section className="library-main">
        <header className="library-header">
          <div><p className="eyebrow">LOCAL LIBRARY</p><h1>Your books</h1></div>
          <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Plus />{busy ? "Importing..." : "Add books"}
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".epub,.pdf,.txt,.md,application/epub+zip,application/pdf,text/plain,text/markdown"
            multiple
            onChange={(event) => void importFiles(Array.from(event.target.files ?? []))}
          />
        </header>

        {message && <div className="notice" role="status"><span>{message}</span><button type="button" onClick={() => setMessage(undefined)} aria-label="Dismiss"><X /></button></div>}
        {updateAction && (
          <div className="notice update-notice" role="status">
            <span>A new WebReader version is ready.</span>
            <button className="notice-action" type="button" onClick={updateAction}>Update</button>
          </div>
        )}

        <div
          className={`drop-zone ${dragging ? "dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void importFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <Import />
          <span>Drop EPUB, PDF, TXT, or Markdown files here</span>
          <small>Up to 250 MB per file</small>
        </div>

        {books.length === 0 ? (
          <section className="empty-state">
            <div className="empty-icon"><BookOpen /></div>
            <h2>Your shelf is empty</h2>
            <p>Add a book to start reading. Your files stay on this device.</p>
            <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}><Plus />Choose files</button>
          </section>
        ) : (
          <section className="book-grid" aria-label="Books">
            {books.map((book) => (
              <article className="book-card" key={book.id}>
                <button className="book-open" type="button" onClick={() => void openBook(book)} aria-label={`Open ${book.title}`}>
                  <div className={`book-cover cover-${book.format}`}>
                    {book.format === "pdf" ? <FileText /> : <BookOpen />}
                    <span>{formatLabel(book.format)}</span>
                  </div>
                  <div className="book-info">
                    <strong>{book.title}</strong>
                    <span>{book.author ?? book.fileName}</span>
                    <div className="progress-track"><i style={{ width: `${Math.round((book.locator?.progression ?? 0) * 100)}%` }} /></div>
                    <small>{book.locator ? `${Math.round(book.locator.progression * 100)}% read` : `Added ${formatDate(book.addedAt)}`} · {formatBytes(book.size)}</small>
                  </div>
                </button>
                <button className="card-menu" type="button" title="Remove book" aria-label={`Remove ${book.title}`} onClick={() => setDeleteTarget(book)}><Trash2 /></button>
              </article>
            ))}
          </section>
        )}
      </section>

      {deleteTarget && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setDeleteTarget(undefined); }}>
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <div className="dialog-icon"><Trash2 /></div>
            <h2 id="delete-title">Remove this book?</h2>
            <p>“{deleteTarget.title}” and its reading progress will be deleted from this browser. The original file on your device is not affected.</p>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setDeleteTarget(undefined)}>Cancel</button>
              <button className="danger-button" type="button" onClick={() => void confirmDelete()}>Remove</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
