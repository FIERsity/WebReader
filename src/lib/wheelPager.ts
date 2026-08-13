export type WheelDirection = "previous" | "next";

interface WheelGestureOptions {
  threshold?: number;
  quietPeriodMs?: number;
}

export class WheelGesture {
  private readonly threshold: number;
  private readonly quietPeriodMs: number;
  private accumulated = 0;
  private lastTimestamp = Number.NEGATIVE_INFINITY;
  private locked = false;
  private eligible = true;

  constructor(options: WheelGestureOptions = {}) {
    this.threshold = options.threshold ?? 40;
    this.quietPeriodMs = options.quietPeriodMs ?? 220;
  }

  push(delta: number, timestamp: number, eligible = true): WheelDirection | undefined {
    if (!Number.isFinite(delta) || delta === 0) return undefined;
    if (timestamp - this.lastTimestamp > this.quietPeriodMs) {
      this.accumulated = 0;
      this.locked = false;
      this.eligible = eligible;
    }
    this.lastTimestamp = timestamp;
    if (this.locked || !this.eligible) return undefined;

    if (this.accumulated !== 0 && Math.sign(delta) !== Math.sign(this.accumulated)) {
      this.accumulated = 0;
    }
    this.accumulated += delta;
    if (Math.abs(this.accumulated) < this.threshold) return undefined;

    this.locked = true;
    return this.accumulated < 0 ? "previous" : "next";
  }

  reset(): void {
    this.accumulated = 0;
    this.lastTimestamp = Number.NEGATIVE_INFINITY;
    this.locked = false;
    this.eligible = true;
  }
}

export function normalizedWheelDelta(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">, viewportSize: number): number {
  const primary = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (event.deltaMode === 1) return primary * 16;
  if (event.deltaMode === 2) return primary * Math.max(1, viewportSize);
  return primary;
}

export function shouldIgnoreWheel(event: WheelEvent): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return true;
  const selection = target instanceof Node ? target.ownerDocument?.getSelection() : undefined;
  return Boolean(selection && !selection.isCollapsed);
}
