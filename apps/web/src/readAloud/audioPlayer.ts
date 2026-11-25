import type { SpeechPlayer } from "./speechQueue";

/** Plays clips back to back on one Web Audio timeline, asleep while there is nothing to say. */
export function createAudioPlayer() {
  let context: AudioContext | null = null;
  let nextStart = 0;
  // Clips still decoding; the context must not fall asleep under them.
  let pending = 0;
  const sources = new Set<AudioBufferSourceNode>();
  const wake = () => {
    context ??= new AudioContext();
    // Not awaited: before any user gesture a browser leaves this promise pending.
    if (context.state !== "running") void context.resume();
    return context;
  };

  const play: SpeechPlayer["play"] = async (audio, signal) => {
    const output = wake();
    pending += 1;
    let buffer: AudioBuffer;
    try {
      // Decoding takes ownership of the buffer, so it gets a copy.
      buffer = await output.decodeAudioData(new Uint8Array(audio).buffer);
      signal.throwIfAborted();
    } finally {
      pending -= 1;
    }
    // The previous clip may have ended (and suspended the context) while this one decoded.
    wake();
    const source = output.createBufferSource();
    source.buffer = buffer;
    source.connect(output.destination);
    const ended = new Promise<void>((resolve) => {
      source.onended = () => {
        source.disconnect();
        sources.delete(source);
        if (sources.size === 0 && pending === 0) void output.suspend();
        resolve();
      };
    });
    const start = Math.max(output.currentTime, nextStart);
    sources.add(source);
    source.start(start);
    nextStart = start + buffer.duration;
    return { ended };
  };

  return {
    play,
    stop: () => {
      for (const source of sources) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      sources.clear();
      nextStart = 0;
      if (context?.state === "running") void context.suspend();
    },
    /** Call from a click or key press, which some browsers require before any sound. */
    unlock: () => {
      wake();
    },
  };
}
