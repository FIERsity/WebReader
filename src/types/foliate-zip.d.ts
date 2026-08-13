declare module "foliate-js/vendor/zip.js" {
  export class BlobReader {
    constructor(blob: Blob);
  }

  export class ZipReader {
    constructor(reader: BlobReader);
    getEntries(): Promise<Array<{
      filename: string;
      directory?: boolean;
      encrypted?: boolean;
      compressedSize: number;
      uncompressedSize: number;
      compressionMethod?: number;
      getData(writer: unknown, options?: { useWebWorkers?: boolean }): Promise<string>;
    }>>;
    close(): Promise<void>;
  }
}
