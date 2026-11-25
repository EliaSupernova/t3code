import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { RunId, ThreadId } from "@t3tools/contracts";
import { createSpeechBudget, createSpeechTextStream } from "@t3tools/shared/readAloud";
import * as Option from "effect/Option";

const LIVE_RUNS = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const STOPPED_RUNS = new Set(["interrupted", "cancelled", "rolled_back"]);
const STOPPED_ITEMS = new Set(["interrupted", "cancelled"]);

export interface ReadAloudStep {
  /** Silence everything queued so far before saying `speak`. */
  readonly stop: boolean;
  readonly speak: ReadonlyArray<string>;
}

/**
 * Decides what to say from successive states of one thread. Only assistant messages that appear
 * while the thread is watched live are spoken; history, catch-up after a reconnect and messages
 * already under way when watching began stay silent.
 */
export function createReplyTracker(options: {
  readonly threadId: ThreadId;
  /** The thread did not exist when watching began, so nothing in it is history. */
  readonly startsEmpty: boolean;
}) {
  const seen = new Set<string>();
  const speaking = new Map<string, ReturnType<typeof createSpeechTextStream>>();
  // One budget per reply: a run's messages share the cost cap.
  const budgets = new Map<string, ReturnType<typeof createSpeechBudget>>();
  const spokenRuns = new Set<RunId>();
  let liveRuns: ReadonlySet<RunId> = new Set();
  let wasLive = false;
  let fresh = options.startsEmpty;

  const observe = (state: EnvironmentThreadState): ReadAloudStep => {
    const projection = Option.getOrNull(state.data);
    const live = state.status === "live";
    const speak: string[] = [];
    let stop = false;
    if (projection === null) {
      wasLive = false;
      return { stop, speak };
    }
    // The first live state, and the one after any gap, only catches up on what was missed.
    const hearing = fresh || (live && wasLive);

    const nowLive = new Set<RunId>();
    for (const run of projection.runs) {
      if (LIVE_RUNS.has(run.status)) nowLive.add(run.id);
      if (STOPPED_RUNS.has(run.status) && spokenRuns.delete(run.id)) {
        stop = true;
        speaking.clear();
      }
    }

    const rows = projection.visibleTurnItems;
    // Rows added before this one are older history being paged in.
    const lastKnown = rows.findLastIndex((row) => seen.has(row.item.id));
    rows.forEach((row, index) => {
      const { item } = row;
      const isNew = !seen.has(item.id);
      seen.add(item.id);
      if (row.visibility !== "local" || item.threadId !== options.threadId) return;
      if (item.type === "user_message") {
        if (isNew && hearing && index > lastKnown && item.createdBy === "user") {
          stop = true;
          speak.length = 0;
          speaking.clear();
        }
        return;
      }
      if (item.type !== "assistant_message") return;
      const { runId } = item;
      // A message that arrives already finished counts only at the end of a run still going.
      const justSaid =
        index > lastKnown && runId !== null && (nowLive.has(runId) || liveRuns.has(runId));
      if (isNew && hearing && !STOPPED_ITEMS.has(item.status) && (item.streaming || justSaid)) {
        speaking.set(item.id, createSpeechTextStream());
      }
      const stream = speaking.get(item.id);
      if (stream === undefined) return;
      if (STOPPED_ITEMS.has(item.status)) {
        stop = true;
        speak.length = 0;
        speaking.clear();
        return;
      }
      const sentences = item.streaming ? stream.push(item.text) : stream.finish(item.text);
      if (!item.streaming) speaking.delete(item.id);
      const replyKey = runId ?? item.id;
      let budget = budgets.get(replyKey);
      if (budget === undefined) {
        budget = createSpeechBudget();
        budgets.set(replyKey, budget);
      }
      const allowed = budget.take(sentences);
      if (allowed.length > 0 && runId !== null) spokenRuns.add(runId);
      speak.push(...allowed);
    });

    liveRuns = nowLive;
    wasLive = live;
    if (live) fresh = false;
    return { stop, speak };
  };

  return {
    observe,
    /** Stay quiet about the messages under way; later ones are spoken again. */
    silence: () => speaking.clear(),
  };
}
