import { describe, expect, it } from "vitest";
import { WheelGesture, normalizedWheelDelta } from "./wheelPager";

describe("wheel pagination gesture", () => {
  it("turns once after accumulated movement and waits for the next gesture", () => {
    const gesture = new WheelGesture({ threshold: 60, quietPeriodMs: 200 });
    expect(gesture.push(20, 0)).toBeUndefined();
    expect(gesture.push(45, 30)).toBe("next");
    expect(gesture.push(100, 80)).toBeUndefined();
    expect(gesture.push(70, 300)).toBe("next");
  });

  it("resets accumulated movement when direction changes", () => {
    const gesture = new WheelGesture({ threshold: 60 });
    expect(gesture.push(50, 0)).toBeUndefined();
    expect(gesture.push(-20, 20)).toBeUndefined();
    expect(gesture.push(-45, 40)).toBe("previous");
  });

  it("does not turn when a gesture starts away from a page boundary", () => {
    const gesture = new WheelGesture({ threshold: 40, quietPeriodMs: 200 });
    expect(gesture.push(50, 0, false)).toBeUndefined();
    expect(gesture.push(50, 40, true)).toBeUndefined();
    expect(gesture.push(50, 300, true)).toBe("next");
  });

  it("normalizes wheel delta modes", () => {
    expect(normalizedWheelDelta({ deltaX: 0, deltaY: 2, deltaMode: 1 }, 800)).toBe(32);
    expect(normalizedWheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 800)).toBe(-800);
    expect(normalizedWheelDelta({ deltaX: 70, deltaY: 12, deltaMode: 0 }, 800)).toBe(70);
  });
});
