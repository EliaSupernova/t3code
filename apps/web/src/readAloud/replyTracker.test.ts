import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { createReplyTracker } from "./replyTracker";

const threadId = ThreadId.make("thread-1");

interface Row {
  id: string;
  type: "assistant_message" | "user_message" | "reasoning" | "command_execution";
  text?: string;
  streaming?: boolean;
  status?: string;
  runId?: string | null;
  createdBy?: string;
  visibility?: string;
}

const said = (id: string, text: string, extra: Partial<Row> = {}): Row => ({
  id,
  type: "assistant_message",
  text,
  streaming: true,
  status: "running",
  ...extra,
});
const done = (id: string, text: string, extra: Partial<Row> = {}) =>
  said(id, text, { streaming: false, status: "completed", ...extra });
const asked = (id: string, extra: Partial<Row> = {}): Row => ({
  id,
  type: "user_message",
  createdBy: "user",
  text: "Please. Do it.",
  ...extra,
});

/** Only the fields the tracker reads. */
const state = (
  rows: ReadonlyArray<Row>,
  runs: Record<string, string> = { "run-1": "running" },
  status: EnvironmentThreadState["status"] = "live",
) =>
  ({
    status,
    data: Option.some({
      runs: Object.entries(runs).map(([id, runStatus]) => ({ id, status: runStatus })),
      visibleTurnItems: rows.map(({ visibility, ...row }) => ({
        visibility: visibility ?? "local",
        item: { threadId, runId: "run-1", status: "running", streaming: false, ...row },
      })),
    }),
  }) as unknown as EnvironmentThreadState;

const empty = { data: Option.none(), status: "empty" } as unknown as EnvironmentThreadState;
const quiet = { stop: false, speak: [] };

const opened = (rows: ReadonlyArray<Row> = [], runs?: Record<string, string>) => {
  const tracker = createReplyTracker({ threadId, startsEmpty: false });
  tracker.observe(state(rows, runs));
  return tracker;
};

describe("what read aloud says", () => {
  it("never reads history, whether it was cached or arrives with the first live state", () => {
    const tracker = createReplyTracker({ threadId, startsEmpty: false });
    expect(tracker.observe(empty)).toEqual(quiet);
    expect(tracker.observe(state([done("old", "Old news.")], {}, "cached"))).toEqual(quiet);
    expect(
      tracker.observe(
        state([done("old", "Old news."), done("older", "More.")], {}, "synchronizing"),
      ),
    ).toEqual(quiet);
    expect(tracker.observe(state([done("old", "Old news."), done("late", "Late.")]))).toEqual(
      quiet,
    );
  });

  it("stays silent about a reply already under way, then speaks the next one", () => {
    const tracker = opened([said("a", "Half a")]);
    expect(tracker.observe(state([said("a", "Half a sentence. More. ")]))).toEqual(quiet);
    expect(
      tracker.observe(state([done("a", "Half a sentence. More."), said("b", "Fresh one. And")])),
    ).toEqual({ stop: false, speak: ["Fresh one."] });
  });

  it("speaks a streaming reply sentence by sentence", () => {
    const tracker = opened();
    expect(tracker.observe(state([asked("q"), said("a", "I loo")])).speak).toEqual([]);
    expect(tracker.observe(state([asked("q"), said("a", "I looked. It is")])).speak).toEqual([
      "I looked.",
    ]);
    expect(tracker.observe(state([asked("q"), done("a", "I looked. It is fine")])).speak).toEqual([
      "It is fine",
    ]);
    expect(tracker.observe(state([asked("q"), done("a", "I looked. It is fine")]))).toEqual(quiet);
  });

  it("speaks a reply that arrives whole while its run is, or just was, going", () => {
    const tracker = opened();
    expect(tracker.observe(state([done("a", "All at once.")])).speak).toEqual(["All at once."]);
    expect(
      tracker.observe(
        state([done("a", "All at once."), done("b", "And the end.")], { "run-1": "completed" }),
      ).speak,
    ).toEqual(["And the end."]);
  });

  it("ignores thinking, tools, other threads' rows and older pages", () => {
    const tracker = opened([done("kept", "Kept.")]);
    expect(
      tracker.observe(
        state([
          done("paged-in", "From long ago."),
          done("kept", "Kept."),
          { id: "r", type: "reasoning", text: "Secret thought. ", streaming: true },
          { id: "c", type: "command_execution", text: "output. " },
          said("child", "Not ours. ", { visibility: "inherited" }),
        ]),
      ),
    ).toEqual(quiet);
  });

  it("starts speaking at once in a thread that did not exist yet", () => {
    const tracker = createReplyTracker({ threadId, startsEmpty: true });
    expect(
      tracker.observe(
        state([asked("q"), said("a", "Hello. ")], { "run-1": "running" }, "synchronizing"),
      ).speak,
    ).toEqual(["Hello."]);
  });

  it("does not read what was missed while reconnecting", () => {
    const tracker = opened();
    expect(tracker.observe(state([said("a", "One. ")])).speak).toEqual(["One."]);
    tracker.observe(state([said("a", "One. ")], undefined, "synchronizing"));
    expect(tracker.observe(state([done("a", "One. Two."), said("missed", "Gap. ")])).speak).toEqual(
      ["Two."],
    );
  });

  it("stops when the user sends a message, and speaks only what answers it", () => {
    const tracker = opened();
    tracker.observe(state([said("a", "One. ")]));
    expect(tracker.observe(state([said("a", "One. Two. "), asked("steer")]))).toEqual({
      stop: true,
      speak: [],
    });
    expect(
      tracker.observe(state([said("a", "One. Two. Three. "), asked("steer"), said("b", "Okay. ")])),
    ).toEqual({ stop: false, speak: ["Okay."] });
  });

  it("keeps talking when another agent sends the message", () => {
    const tracker = opened();
    tracker.observe(state([said("a", "One. ")]));
    expect(
      tracker.observe(state([said("a", "One. Two. "), asked("n", { createdBy: "agent" })])),
    ).toEqual({ stop: false, speak: ["Two."] });
  });

  it.each(["interrupted", "cancelled", "rolled_back"])(
    "stops when a spoken run is %s, even after its message finished",
    (status) => {
      const tracker = opened();
      tracker.observe(state([done("a", "Said.")]));
      expect(tracker.observe(state([done("a", "Said.")], { "run-1": status }))).toEqual({
        stop: true,
        speak: [],
      });
      expect(tracker.observe(state([done("a", "Said.")], { "run-1": status }))).toEqual(quiet);
    },
  );

  it("stops when the message itself is interrupted, without saying the rest", () => {
    const tracker = opened();
    tracker.observe(state([said("a", "One. Tw")]));
    expect(
      tracker.observe(state([said("a", "One. Two", { streaming: false, status: "interrupted" })])),
    ).toEqual({ stop: true, speak: [] });
  });

  it("says nothing more of a silenced message", () => {
    const tracker = opened();
    tracker.observe(state([said("a", "One. ")]));
    tracker.silence();
    expect(tracker.observe(state([said("a", "One. Two. ")]))).toEqual(quiet);
  });

  it("caps one reply at 3,000 characters across its messages", () => {
    const sentence = `${"a".repeat(399)}.`; // 400 characters
    const five = Array.from({ length: 5 }, () => sentence).join(" ");
    const tracker = opened();
    expect(tracker.observe(state([done("a", five)])).speak).toHaveLength(5); // 2,000
    // Two more sentences fit (2,800); a third would make 3,200.
    expect(tracker.observe(state([done("a", five), done("b", five)])).speak).toHaveLength(2);
    expect(
      tracker.observe(state([done("a", five), done("b", five), done("c", "Short.")])).speak,
    ).toEqual([]);
    // A new reply has its own allowance.
    expect(
      tracker.observe(
        state([done("a", five), done("b", five), done("d", "New reply.", { runId: "run-2" })], {
          "run-1": "completed",
          "run-2": "running",
        }),
      ).speak,
    ).toEqual(["New reply."]);
  });
});
