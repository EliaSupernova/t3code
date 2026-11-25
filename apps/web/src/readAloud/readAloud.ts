import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { getReadAloudStatus, synthesizeReadAloud } from "@t3tools/client-runtime/voice-input";
import { ReadAloudError, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { updateClientSettings } from "../hooks/useSettings";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { readPrimaryEnvironmentId } from "../state/environments";
import { readPreparedConnection } from "../state/session";
import { environmentThreadDetails } from "../state/threads";
import { createAudioPlayer } from "./audioPlayer";
import { createReplyTracker } from "./replyTracker";
import { createSpeechQueue } from "./speechQueue";

const isReadAloudError = Schema.is(ReadAloudError);

/** Why read aloud last failed to start; the toggle shows it. */
export const readAloudProblemAtom = Atom.make<"missing-key" | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("read-aloud-problem"),
);

interface Watch {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly tracker: ReturnType<typeof createReplyTracker>;
  holders: number;
  unsubscribe: (() => void) | null;
}

let watch: Watch | null = null;

/**
 * The key belongs to the machine running this app, so its own server speaks, also for threads on
 * other environments. A client without a local server asks the thread's environment.
 */
function voiceConnection(threadEnvironmentId: EnvironmentId) {
  const primary = readPrimaryEnvironmentId();
  const prepared =
    (primary === null ? null : readPreparedConnection(primary)) ??
    readPreparedConnection(threadEnvironmentId);
  if (prepared === null) throw new ReadAloudError({ reason: "unavailable" });
  return prepared;
}

const player = createAudioPlayer();
const queue = createSpeechQueue({
  player,
  synthesize: async (text, signal) => {
    if (watch === null) throw new ReadAloudError({ reason: "unavailable" });
    return runEnvironmentSpeech(synthesizeReadAloud(voiceConnection(watch.environmentId), text), {
      signal,
    });
  },
  onError: (error) => {
    watch?.tracker.silence();
    reportProblem(error);
  },
});

function reportProblem(error: unknown) {
  if (isReadAloudError(error) && error.reason === "missing-key") {
    appAtomRegistry.set(readAloudProblemAtom, "missing-key");
    queue.stop();
    void updateClientSettings({ readAloudEnabled: false });
    toastManager.add({
      id: "read-aloud",
      type: "error",
      title: m(msg("No ElevenLabs key found")),
    });
    return;
  }
  const description = !isReadAloudError(error)
    ? m(msg("Check that the server is connected and up to date."))
    : error.reason === "rejected-key"
      ? m(msg("ElevenLabs refused the request. Check the key and its credits."))
      : error.reason === "rate-limit"
        ? m(msg("ElevenLabs is limiting requests. Try again shortly."))
        : m(msg("ElevenLabs could not make the audio."));
  toastManager.add({
    id: "read-aloud",
    type: "error",
    title: m(msg("Could not read the reply aloud")),
    description,
  });
}

function release() {
  watch?.unsubscribe?.();
  watch = null;
  queue.stop();
}

/**
 * Speaks new replies in this thread until the returned function runs. Watching another thread
 * stops the one before. Releasing and watching the same thread again at once changes nothing.
 */
export function watchReadAloudThread(threadRef: ScopedThreadRef, isServerThread: boolean) {
  const key = scopedThreadKey(threadRef);
  if (watch?.key !== key) {
    release();
    watch = {
      key,
      environmentId: threadRef.environmentId,
      tracker: createReplyTracker({ threadId: threadRef.threadId, startsEmpty: !isServerThread }),
      holders: 0,
      unsubscribe: null,
    };
  }
  const current = watch;
  current.holders++;
  if (isServerThread && current.unsubscribe === null) {
    current.unsubscribe = appAtomRegistry.subscribe(
      environmentThreadDetails.stateAtom(threadRef),
      (state) => {
        const step = current.tracker.observe(state);
        if (step.stop) queue.stop();
        queue.enqueue(step.speak);
      },
      { immediate: true },
    );
  }
  return () => {
    current.holders--;
    queueMicrotask(() => {
      if (current.holders === 0 && watch === current) release();
    });
  };
}

/** The user sent a message or interrupted the reply: stop talking about it. */
export function silenceReadAloud() {
  if (watch === null) return;
  watch.tracker.silence();
  queue.stop();
  // Some browsers only allow sound after a gesture, such as this one.
  player.unlock();
}

/** The user turned read aloud on: allow sound, then confirm there is a key to speak with. */
export async function startReadAloud(threadEnvironmentId: EnvironmentId) {
  player.unlock();
  appAtomRegistry.set(readAloudProblemAtom, null);
  void updateClientSettings({ readAloudEnabled: true });
  try {
    const status = await runEnvironmentSpeech(
      getReadAloudStatus(voiceConnection(threadEnvironmentId)),
    );
    if (!status.available) reportProblem(new ReadAloudError({ reason: "missing-key" }));
  } catch (error) {
    reportProblem(error);
  }
}
