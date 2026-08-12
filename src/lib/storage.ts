import Dexie, { type EntityTable } from "dexie";
import type { BookRecord, ReaderPreferences, ReadingLocator } from "../types/library";
import { normalizePreferences } from "./preferences";

interface FileRecord {
  bookId: string;
  blob: Blob;
}

interface SettingRecord {
  key: string;
  value: unknown;
}

class WebReaderDatabase extends Dexie {
  books!: EntityTable<BookRecord, "id">;
  files!: EntityTable<FileRecord, "bookId">;
  settings!: EntityTable<SettingRecord, "key">;

  constructor() {
    super("webreader");
    this.version(1).stores({
      books: "id, &fingerprint, addedAt, updatedAt, format",
      files: "bookId",
      settings: "key",
    });
  }
}

export const db = new WebReaderDatabase();

export async function listBooks(): Promise<BookRecord[]> {
  return db.books.orderBy("updatedAt").reverse().toArray();
}

export async function saveBook(book: BookRecord, file: File): Promise<void> {
  await db.transaction("rw", db.books, db.files, async () => {
    await db.books.put(book);
    await db.files.put({ bookId: book.id, blob: file });
  });
}

export async function findByFingerprint(fingerprint: string): Promise<BookRecord | undefined> {
  return db.books.where("fingerprint").equals(fingerprint).first();
}

export async function getBookFile(bookId: string): Promise<Blob> {
  const record = await db.files.get(bookId);
  if (!record) throw new Error("The local book file is missing. Re-import the original file.");
  return record.blob;
}

export async function updateLocator(bookId: string, locator: ReadingLocator): Promise<void> {
  await db.books.update(bookId, { locator, updatedAt: Date.now() });
}

export async function removeBook(bookId: string): Promise<void> {
  await db.transaction("rw", db.books, db.files, async () => {
    await db.books.delete(bookId);
    await db.files.delete(bookId);
  });
}

export async function getPreferences(): Promise<ReaderPreferences> {
  const record = await db.settings.get("reader-preferences");
  return normalizePreferences(record?.value);
}

export async function savePreferences(preferences: ReaderPreferences): Promise<void> {
  await db.settings.put({ key: "reader-preferences", value: normalizePreferences(preferences) });
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
