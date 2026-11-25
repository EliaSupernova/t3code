import { describe, expect, it } from "vite-plus/test";

import { createSpeechQueue } from "./speechQueue";

/** Lets every already-resolved promise run its continuations; the fakes use nothing else. */
async function settle() {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
}

function setup() {
  const requests: Array<{
    text: string;
    signal: AbortSignal;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  const clips: Array<{ text: string; end: () => void }> = [];
  const errors: unknown[] = [];
  let stops = 0;
  const queue = createSpeechQueue({
    synthesize: (text, signal) =>
      new Promise((resolve, reject) => {
        requests.push({
          text,
          signal,
          resolve: () => resolve(new TextEncoder().encode(text)),
          reject,
        });
      }),
    player: {
      play: async (audio) => {
        let end = () => {};
        const ended = new Promise<void>((resolve) => (end = resolve));
        clips.push({ text: new TextDecoder().decode(audio), end });
        return { ended };
      },
      stop: () => stops++,
    },
    onError: (error) => errors.push(error),
  });
  return {
    queue,
    requests,
    clips,
    errors,
    stops: () => stops,
    asked: () => requests.map((request) => request.text),
    played: () => clips.map((clip) => clip.text),
  };
}

describe("speech queue", () => {
  it("plays in the order written, even when a later clip is ready first", async () => {
    const t = setup();
    t.queue.enqueue(["one", "two"]);
    t.requests[1]!.resolve();
    await settle();
    expect(t.played()).toEqual([]);
    t.requests[0]!.resolve();
    await settle();
    expect(t.played()).toEqual(["one", "two"]);
  });

  it("asks for at most two at once and stays at most three clips ahead", async () => {
    const t = setup();
    t.queue.enqueue(["1", "2", "3", "4", "5"]);
    expect(t.asked()).toEqual(["1", "2"]);
    t.requests[0]!.resolve();
    await settle();
    expect(t.asked()).toEqual(["1", "2", "3"]);
    t.requests[1]!.resolve();
    t.requests[2]!.resolve();
    await settle();
    expect(t.played()).toEqual(["1", "2", "3"]);
    expect(t.asked()).toEqual(["1", "2", "3"]);
    t.clips[0]!.end();
    await settle();
    expect(t.asked()).toEqual(["1", "2", "3", "4"]);
  });

  it("schedules the next clip while the one before is still playing", async () => {
    const t = setup();
    t.queue.enqueue(["a"]);
    t.requests[0]!.resolve();
    await settle();
    t.queue.enqueue(["b"]);
    t.requests[1]!.resolve();
    await settle();
    expect(t.played()).toEqual(["a", "b"]);
  });

  it("on stop cancels requests, silences the player and drops what waited", async () => {
    const t = setup();
    t.queue.enqueue(["1", "2", "3"]);
    t.queue.stop();
    expect(t.requests.map((request) => request.signal.aborted)).toEqual([true, true]);
    expect(t.stops()).toBe(1);
    t.requests[0]!.resolve();
    t.requests[1]!.reject(new Error("aborted"));
    await settle();
    expect(t.played()).toEqual([]);
    expect(t.errors).toEqual([]);
    t.queue.enqueue(["next"]);
    expect(t.asked()).toEqual(["1", "2", "next"]);
    t.requests[2]!.resolve();
    await settle();
    expect(t.played()).toEqual(["next"]);
  });

  it("reports one failure, drops the rest and works again afterwards", async () => {
    const t = setup();
    t.queue.enqueue(["1", "2", "3"]);
    t.requests[1]!.reject(new Error("second failed"));
    t.requests[0]!.resolve();
    await settle();
    expect(t.played()).toEqual(["1"]);
    expect(t.errors).toEqual([new Error("second failed")]);
    // The earlier clip is left to finish.
    expect(t.stops()).toBe(0);
    expect(t.asked()).not.toContain("4");
    t.queue.enqueue(["again"]);
    t.requests.at(-1)!.resolve();
    await settle();
    expect(t.played()).toEqual(["1", "again"]);
  });
});
