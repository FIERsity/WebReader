import Dexie, { type EntityTable } from "dexie";
import type { BookRecord, ReaderPreferences, ReadingLocator, ReadingProfile } from "../types/library";
import type { TranslationCacheRecord, TranslationTargetLanguage } from "../types/translation";
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
  translations!: EntityTable<TranslationCacheRecord, "key">;

  constructor() {
    super("webreader");
    this.version(1).stores({
      books: "id, &fingerprint, addedAt, updatedAt, format",
      files: "bookId",
      settings: "key",
    });
    this.version(2).stores({
      books: "id, &fingerprint, addedAt, updatedAt, format, readingProfile",
      files: "bookId",
      settings: "key",
    }).upgrade(async (transaction) => {
      await transaction.table<BookRecord>("books").toCollection().modify((book) => {
        book.readingProfile = book.readingProfile === "article" ? "article" : "book";
      });
    });
    this.version(3).stores({
      books: "id, &fingerprint, addedAt, updatedAt, format, readingProfile",
      files: "bookId",
      settings: "key",
      translations: "&key, bookId, [bookId+documentRevision+targetLanguage], updatedAt",
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

export async function updateReadingProfile(bookId: string, readingProfile: ReadingProfile): Promise<void> {
  await db.books.update(bookId, { readingProfile });
}

export async function getTranslation(key: string): Promise<TranslationCacheRecord | undefined> {
  return db.translations.get(key);
}

export async function listTranslations(
  bookId: string,
  documentRevision: string,
  targetLanguage: TranslationTargetLanguage,
): Promise<TranslationCacheRecord[]> {
  return db.translations.where("[bookId+documentRevision+targetLanguage]")
    .equals([bookId, documentRevision, targetLanguage]).toArray();
}

export async function putTranslation(record: TranslationCacheRecord): Promise<boolean> {
  return db.transaction("rw", db.books, db.translations, async () => {
    if (!await db.books.get(record.bookId)) return false;
    await db.translations.put(record);
    return true;
  });
}

export async function removeBook(bookId: string): Promise<void> {
  await db.transaction("rw", db.books, db.files, db.translations, async () => {
    await db.books.delete(bookId);
    await db.files.delete(bookId);
    await db.translations.where("bookId").equals(bookId).delete();
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
