export interface PdfLocation {
  page: number;
  offset: number;
}

export function parsePdfLocation(value: string | undefined): PdfLocation {
  if (!value) return { page: 1, offset: 0 };
  const [pageValue, offsetValue] = value.split(":", 2);
  const page = Number(pageValue);
  const offset = Number(offsetValue);
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    offset: Number.isFinite(offset) ? Math.max(0, Math.min(1, offset)) : 0,
  };
}

export function serializePdfLocation(page: number, offset: number): string {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safeOffset = Math.max(0, Math.min(1, Number.isFinite(offset) ? offset : 0));
  return safeOffset === 0 ? String(safePage) : `${safePage}:${safeOffset.toFixed(4)}`;
}
