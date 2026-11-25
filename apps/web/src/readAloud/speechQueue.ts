export interface SpeechPlayer {
  /** Schedules the clip right after the ones before it; `ended` resolves once it has played. */
  readonly play: (audio: Uint8Array, signal: AbortSignal) => Promise<{ ended: Promise<void> }>;
  /** Silences and forgets every scheduled clip. */
  readonly stop: () => void;
}

// ElevenLabs limits parallel requests, and anything fetched but unheard is still billed.
const MAX_REQUESTS = 2;
// The clip being heard and two behind it, so the next one is ready when it ends.
const MAX_CLIPS = 3;

const newBatch = () => ({
  abort: new AbortController(),
  waiting: [] as string[],
  fetched: [] as Promise<Uint8Array>[],
  playing: 0,
  scheduling: false,
});

/** Speaks sentences in order: fetches a little ahead and never lets two clips overlap. */
export function createSpeechQueue(options: {
  readonly synthesize: (text: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly player: SpeechPlayer;
  /** A sentence failed. What is already scheduled plays out; the rest is dropped. */
  readonly onError: (error: unknown) => void;
}) {
  let batch = newBatch();

  const pump = (current: typeof batch) => {
    while (
      current.waiting.length > 0 &&
      current.fetched.length < MAX_REQUESTS &&
      current.fetched.length + current.playing < MAX_CLIPS
    ) {
      const audio = options.synthesize(current.waiting.shift()!, current.abort.signal);
      // Awaited in order below; a later clip may fail before its turn.
      audio.catch(() => {});
      current.fetched.push(audio);
    }
    if (!current.scheduling) void schedule(current);
  };

  const schedule = async (current: typeof batch) => {
    current.scheduling = true;
    const { signal } = current.abort;
    try {
      while (current.fetched.length > 0 && !signal.aborted) {
        const audio = await current.fetched[0]!;
        if (signal.aborted) return;
        const clip = await options.player.play(audio, signal);
        if (signal.aborted) return;
        current.fetched.shift();
        current.playing++;
        void clip.ended.then(() => {
          current.playing--;
          if (!signal.aborted) pump(current);
        });
        pump(current);
      }
      current.scheduling = false;
    } catch (error) {
      if (signal.aborted) return;
      current.abort.abort();
      batch = newBatch();
      options.onError(error);
    }
  };

  return {
    enqueue: (sentences: ReadonlyArray<string>) => {
      if (sentences.length === 0) return;
      batch.waiting.push(...sentences);
      pump(batch);
    },
    stop: () => {
      batch.abort.abort();
      batch = newBatch();
      options.player.stop();
    },
  };
}
