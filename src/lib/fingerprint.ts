const BLOCK_SIZE = 1024 * 1024;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintFile(file: File): Promise<string> {
  const metadata = new TextEncoder().encode(`${file.size}:${file.type}:${file.name}`);
  const first = await file.slice(0, BLOCK_SIZE).arrayBuffer();
  const lastStart = Math.max(0, file.size - BLOCK_SIZE);
  const last = await file.slice(lastStart).arrayBuffer();
  const input = new Uint8Array(metadata.byteLength + first.byteLength + last.byteLength);
  input.set(metadata, 0);
  input.set(new Uint8Array(first), metadata.byteLength);
  input.set(new Uint8Array(last), metadata.byteLength + first.byteLength);
  return toHex(await crypto.subtle.digest("SHA-256", input));
}
