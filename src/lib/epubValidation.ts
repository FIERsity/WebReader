const MAX_EPUB_ENTRIES = 20_000;
const MAX_EPUB_ENTRY_SIZE = 100 * 1024 * 1024;
const MAX_EPUB_EXPANDED_SIZE = 500 * 1024 * 1024;
const MAX_EPUB_COMPRESSION_RATIO = 1_000;
const MAX_EPUB_CONTROL_FILE_SIZE = 2 * 1024 * 1024;

interface ZipEntry {
  filename: string;
  directory?: boolean;
  encrypted?: boolean;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod?: number;
  getData(writer: unknown, options?: { useWebWorkers?: boolean }): Promise<string>;
}

interface ZipReader {
  getEntries(): Promise<ZipEntry[]>;
  close(): Promise<void>;
}

function hasUnsafeArchivePath(path: string): boolean {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return true;
  const segments = path.split("/");
  return segments.some((segment) => segment === ".." || segment === ".");
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(?:quot|apos|amp|lt|gt);/g, (entity) => ({
    "&quot;": '"',
    "&apos;": "'",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
  })[entity] ?? entity);
}

function findRootfilePath(containerXml: string): string | undefined {
  const rootfile = containerXml.match(/<(?:[\w.-]+:)?rootfile\b[^>]*>/i)?.[0];
  const match = rootfile?.match(/\bfull-path\s*=\s*(["'])(.*?)\1/i);
  return match ? decodeXmlAttribute(match[2]) : undefined;
}

function isValidPackageDocument(opf: string): boolean {
  return /<(?:[\w.-]+:)?package\b/i.test(opf)
    && /<(?:[\w.-]+:)?manifest\b/i.test(opf)
    && /<(?:[\w.-]+:)?spine\b/i.test(opf);
}

class BoundedTextWriter {
  readonly writable: WritableStream<Uint8Array>;
  readonly #chunks: Uint8Array[] = [];
  #size = 0;

  constructor(limit: number) {
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.#size + chunk.byteLength > limit) throw new RangeError("EPUB control file exceeds its expanded byte limit");
        this.#chunks.push(chunk.slice());
        this.#size += chunk.byteLength;
      },
    });
  }

  getData(): string {
    const bytes = new Uint8Array(this.#size);
    let offset = 0;
    for (const chunk of this.#chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
}

async function loadBoundedText(entry: ZipEntry): Promise<string> {
  if (entry.uncompressedSize > MAX_EPUB_CONTROL_FILE_SIZE) throw new Error("EPUB control file is too large");
  return entry.getData(new BoundedTextWriter(MAX_EPUB_CONTROL_FILE_SIZE), { useWebWorkers: false });
}

export async function validateEpubContainer(file: File): Promise<void> {
  const { BlobReader, ZipReader } = await import("foliate-js/vendor/zip.js");
  const reader = new ZipReader(new BlobReader(file)) as ZipReader;

  try {
    const entries = await reader.getEntries();
    if (entries.length === 0 || entries.length > MAX_EPUB_ENTRIES) throw new Error("Invalid EPUB entry count");

    let expandedSize = 0;
    const files = new Map<string, ZipEntry>();
    for (const entry of entries) {
      if (hasUnsafeArchivePath(entry.filename) || entry.encrypted) throw new Error("Unsafe EPUB entry");
      if (entry.directory) continue;
      if (files.has(entry.filename)) throw new Error("Duplicate EPUB entry");
      if (entry.uncompressedSize > MAX_EPUB_ENTRY_SIZE) throw new Error("EPUB entry is too large");

      expandedSize += entry.uncompressedSize;
      if (expandedSize > MAX_EPUB_EXPANDED_SIZE) throw new Error("EPUB expands beyond the safety limit");
      if (entry.uncompressedSize >= 10 * 1024 * 1024
        && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > MAX_EPUB_COMPRESSION_RATIO) {
        throw new Error("EPUB entry has an unsafe compression ratio");
      }
      files.set(entry.filename, entry);
    }

    const mimetype = files.get("mimetype");
    const container = files.get("META-INF/container.xml");
    if (entries[0]?.filename !== "mimetype" || !mimetype || !container || mimetype.compressionMethod !== 0) {
      throw new Error("Missing EPUB metadata");
    }
    if (await loadBoundedText(mimetype) !== "application/epub+zip") {
      throw new Error("Invalid EPUB mimetype");
    }

    const opfPath = findRootfilePath(await loadBoundedText(container));
    if (!opfPath || hasUnsafeArchivePath(opfPath)) throw new Error("Invalid EPUB container");
    const opf = files.get(opfPath);
    if (!opf || !isValidPackageDocument(await loadBoundedText(opf))) {
      throw new Error("Invalid EPUB package document");
    }
  } finally {
    await reader.close();
  }
}
