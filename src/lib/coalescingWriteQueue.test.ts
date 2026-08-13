import { describe, expect, it, vi } from "vitest";
import { CoalescingWriteQueue } from "./coalescingWriteQueue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("CoalescingWriteQueue", () => {
  it("serializes writes and keeps only the latest pending value for a key", async () => {
    const first = deferred();
    const writes: Array<[string, number]> = [];
    const queue = new CoalescingWriteQueue<string, number>(async (key, value) => {
      writes.push([key, value]);
      if (value === 1) await first.promise;
    });

    queue.enqueue("book", 1);
    queue.enqueue("book", 2);
    queue.enqueue("book", 3);
    expect(writes).toEqual([["book", 1]]);

    first.resolve();
    await queue.flush();
    expect(writes).toEqual([["book", 1], ["book", 3]]);
  });

  it("does not coalesce values belonging to different keys", async () => {
    const writes: Array<[string, number]> = [];
    const queue = new CoalescingWriteQueue<string, number>(async (key, value) => {
      writes.push([key, value]);
    });

    queue.enqueue("first", 1);
    queue.enqueue("second", 2);
    await queue.flush();
    expect(writes).toEqual([["first", 1], ["second", 2]]);
  });

  it("reports a failed write and continues with later values", async () => {
    const failure = vi.fn();
    const writes: number[] = [];
    const queue = new CoalescingWriteQueue<string, number>(async (_key, value) => {
      writes.push(value);
      if (value === 1) throw new Error("unavailable");
    }, failure);

    queue.enqueue("preferences", 1);
    await queue.flush();
    queue.enqueue("preferences", 2);
    await queue.flush();

    expect(writes).toEqual([1, 2]);
    expect(failure).toHaveBeenCalledOnce();
  });
});
