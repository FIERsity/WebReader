export const MAX_PDF_CANVAS_PIXELS = 16_000_000;

export function fitsCanvasLimit(width: number, height: number, outputScale: number): boolean {
  if (![width, height, outputScale].every(Number.isFinite)) return false;
  if (width <= 0 || height <= 0 || outputScale <= 0) return false;
  return width * height * outputScale * outputScale <= MAX_PDF_CANVAS_PIXELS;
}
