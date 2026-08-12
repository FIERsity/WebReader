import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BookRecord, ReadingLocator } from "../types/library";
import { DEFAULT_PREFERENCES } from "../types/library";
import {
  db, findByFingerprint, getBookFile, getPreferences, listBooks, removeBook,
  saveBook, savePreferences, updateLocator,
} from "./storage";

function record(): BookRecord {
  return {
    id: "book-1",
    fingerprint: "fingerprint-1",
    title: "Fixture",
    format: "txt",
    fileName: "fixture.txt",
    mediaType: "text/plain",
    size: 7,
    addedAt: 10,
    updatedAt: 10,
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(async () => {
  db.close();
});

describe("local book repository", () => {
  it("stores metadata and source bytes together and removes both", async () => {
    const book = record();
    await saveBook(book, new File(["fixture"], book.fileName, { type: book.mediaType }));

    expect(await listBooks()).toEqual([book]);
    expect(await findByFingerprint(book.fingerprint)).toEqual(book);
    expect(await (await getBookFile(book.id)).text()).toBe("fixture");

    await removeBook(book.id);
    expect(await listBooks()).toEqual([]);
    await expect(getBookFile(book.id)).rejects.toThrow(/missing/);
  });

  it("updates format-specific progress without replacing the source file", async () => {
    const book = record();
    await saveBook(book, new File(["fixture"], book.fileName));
    const locator: ReadingLocator = { type: "text", value: "4", progression: 0.5, label: "50%" };
    await updateLocator(book.id, locator);

    expect((await listBooks())[0]?.locator).toEqual(locator);
    expect(await (await getBookFile(book.id)).text()).toBe("fixture");
  });

  it("migrates stored preferences to current defaults", async () => {
    await db.settings.put({ key: "reader-preferences", value: { theme: "night", fontScale: 1.2, lineHeight: 1.8 } });
    expect(await getPreferences()).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: "night",
      fontSizePercent: 120,
      lineHeight: 1.9,
    });

    await savePreferences({ ...DEFAULT_PREFERENCES, theme: "white", fontFamily: "sans" });
    expect(await getPreferences()).toEqual({ ...DEFAULT_PREFERENCES, theme: "white", fontFamily: "sans" });
  });
});
