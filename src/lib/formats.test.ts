import { describe, expect, it } from "vitest";
import { detectBookFormat, displayTitle, formatBytes, MAX_FILE_SIZE, MAX_TEXT_FILE_SIZE } from "./formats";

function file(bytes: number[], name: string, type = ""): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function archiveFile(bytes: Uint8Array, name: string): File {
  return new File([bytes.buffer as ArrayBuffer], name);
}

interface ZipFixtureEntry {
  name: string;
  content?: string;
  encrypted?: boolean;
  declaredSize?: number;
}

function zip(entries: ZipFixtureEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const uint16 = (view: DataView, at: number, value: number) => view.setUint16(at, value, true);
  const uint32 = (view: DataView, at: number, value: number) => view.setUint32(at, value, true);

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.content ?? "");
    const size = entry.declaredSize ?? data.length;
    const flags = entry.encrypted ? 1 : 0;
    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    uint32(localView, 0, 0x04034b50);
    uint16(localView, 4, 20);
    uint16(localView, 6, flags);
    uint32(localView, 18, data.length);
    uint32(localView, 22, size);
    uint16(localView, 26, name.length);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    parts.push(local);

    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    uint32(recordView, 0, 0x02014b50);
    uint16(recordView, 4, 20);
    uint16(recordView, 6, 20);
    uint16(recordView, 8, flags);
    uint32(recordView, 20, data.length);
    uint32(recordView, 24, size);
    uint16(recordView, 28, name.length);
    uint32(recordView, 42, offset);
    record.set(name, 46);
    central.push(record);
    offset += local.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  uint32(endView, 0, 0x06054b50);
  uint16(endView, 8, entries.length);
  uint16(endView, 10, entries.length);
  uint32(endView, 12, centralSize);
  uint32(endView, 16, offset);
  const output = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...parts, ...central, end]) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

function epub(overrides: ZipFixtureEntry[] = []): Uint8Array {
  return zip([
    { name: "mimetype", content: "application/epub+zip" },
    { name: "META-INF/container.xml", content: '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>' },
    { name: "OPS/book.opf", content: "<package><manifest></manifest><spine></spine></package>" },
    ...overrides,
  ]);
}

describe("detectBookFormat", () => {
  it("requires both a PDF signature and a PDF hint", async () => {
    await expect(detectBookFormat(file([0x25, 0x50, 0x44, 0x46, 0x2d], "book.pdf"))).resolves.toBe("pdf");
    await expect(detectBookFormat(file([0x25, 0x50, 0x44, 0x46, 0x2d], "book.txt"))).resolves.toBe("txt");
  });

  it("accepts a valid EPUB container only when identified as EPUB", async () => {
    const bytes = epub();
    await expect(detectBookFormat(archiveFile(bytes, "book.epub"))).resolves.toBe("epub");
    await expect(detectBookFormat(archiveFile(bytes, "archive.zip"))).rejects.toMatchObject({ translationKey: "unsupportedFormat" });
  });

  it("rejects renamed ZIP files that do not contain an EPUB package", async () => {
    const bytes = zip([{ name: "notes.txt", content: "not a book" }]);
    await expect(detectBookFormat(archiveFile(bytes, "book.epub"))).rejects.toMatchObject({ translationKey: "invalidEpub" });
  });

  it("rejects unsafe, encrypted, and excessive EPUB entries", async () => {
    await expect(detectBookFormat(archiveFile(epub([{ name: "../outside.txt" }]), "unsafe.epub")))
      .rejects.toMatchObject({ translationKey: "invalidEpub" });
    await expect(detectBookFormat(archiveFile(epub([{ name: "OPS/secret.xhtml", encrypted: true }]), "encrypted.epub")))
      .rejects.toMatchObject({ translationKey: "invalidEpub" });
    await expect(detectBookFormat(archiveFile(epub([{ name: "OPS/huge.xhtml", content: "x", declaredSize: 101 * 1024 * 1024 }]), "huge.epub")))
      .rejects.toMatchObject({ translationKey: "invalidEpub" });
  });

  it("rejects duplicate paths and missing package documents", async () => {
    await expect(detectBookFormat(archiveFile(epub([{ name: "OPS/book.opf", content: "duplicate" }]), "duplicate.epub")))
      .rejects.toMatchObject({ translationKey: "invalidEpub" });
    const missingPackage = zip([
      { name: "mimetype", content: "application/epub+zip" },
      { name: "META-INF/container.xml", content: '<container><rootfiles><rootfile full-path="OPS/missing.opf"/></rootfiles></container>' },
    ]);
    await expect(detectBookFormat(archiveFile(missingPackage, "missing.epub")))
      .rejects.toMatchObject({ translationKey: "invalidEpub" });
  });

  it("enforces the actual expanded byte limit for EPUB control files", async () => {
    const oversizedControl = `${'<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'}${" ".repeat(2 * 1024 * 1024)}`;
    const bytes = zip([
      { name: "mimetype", content: "application/epub+zip" },
      { name: "META-INF/container.xml", content: oversizedControl, declaredSize: 1 },
      { name: "OPS/book.opf", content: "<package><manifest></manifest><spine></spine></package>" },
    ]);
    await expect(detectBookFormat(archiveFile(bytes, "oversized-control.epub")))
      .rejects.toMatchObject({ translationKey: "invalidEpub" });
  });

  it("rejects empty and oversized files", async () => {
    await expect(detectBookFormat(new File([], "empty.txt", { type: "text/plain" }))).rejects.toMatchObject({ translationKey: "emptyFile" });
    const oversized = { name: "large.pdf", type: "application/pdf", size: MAX_FILE_SIZE + 1 } as File;
    await expect(detectBookFormat(oversized)).rejects.toMatchObject({ translationKey: "fileTooLarge" });
  });

  it("uses a lower safety limit for text rendered into browser DOM", async () => {
    const oversizedText = { name: "large.md", type: "text/markdown", size: MAX_TEXT_FILE_SIZE + 1 } as File;
    await expect(detectBookFormat(oversizedText)).rejects.toMatchObject({ translationKey: "textFileTooLarge" });
  });
});

describe("display helpers", () => {
  it("derives a readable title", () => expect(displayTitle("the_left-hand.epub")).toBe("the left hand"));
  it("formats file sizes", () => {
    expect(formatBytes(100)).toBe("100 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
