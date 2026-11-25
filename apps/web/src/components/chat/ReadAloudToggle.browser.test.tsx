import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  available: true,
  seconds: 0.1,
  spoken: [] as string[],
  threads: new Map<string, unknown>(),
}));

/** Silence, as a real file the browser can decode. */
function silentWave(seconds: number) {
  const samples = Math.round(16_000 * seconds);
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const tag = (at: number, value: string) =>
    [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, view.byteLength - 8, true);
  tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Uint8Array(view.buffer);
}

const threadAtom = (threadId: string) => {
  let atom = fake.threads.get(threadId);
  if (atom === undefined) {
    atom = Atom.make({ status: "live", data: Option.none() } as unknown).pipe(Atom.keepAlive);
    fake.threads.set(threadId, atom);
  }
  return atom as Atom.Writable<unknown>;
};

vi.mock(import("../../state/threads"), () => ({
  environmentThreadDetails: {
    stateAtom: (ref: { threadId: string }) => threadAtom(ref.threadId),
  } as never,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readPreparedConnection: () => ({}) as never,
}));
// The requests are faked as plain promises, so running one is just awaiting it.
vi.mock(import("../../speech/runEnvironmentSpeech"), () => ({
  runEnvironmentSpeech: ((request: Promise<unknown>) => request) as never,
}));
vi.mock(import("@t3tools/client-runtime/voice-input"), async (importOriginal) => ({
  ...(await importOriginal()),
  getReadAloudStatus: (() => Promise.resolve({ available: fake.available })) as never,
  synthesizeReadAloud: ((_prepared: unknown, text: string) => {
    fake.spoken.push(text);
    return Promise.resolve(silentWave(fake.seconds));
  }) as never,
}));

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { createAudioPlayer } from "../../readAloud/audioPlayer";
import { silenceReadAloud } from "../../readAloud/readAloud";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import { ReadAloudToggle } from "./ReadAloudToggle";

const toggle = (threadId: string) => (
  <ReadAloudToggle
    environmentId={EnvironmentId.make("environment")}
    threadId={ThreadId.make(threadId)}
    isServerThread
  />
);

function receive(threadId: string, text: string, streaming = true) {
  appAtomRegistry.set(threadAtom(threadId), {
    status: "live",
    data: Option.some({
      runs: [{ id: "run", status: "running" }],
      visibleTurnItems: [
        {
          visibility: "local",
          item: {
            id: `${threadId}-reply`,
            type: "assistant_message",
            threadId,
            runId: "run",
            status: streaming ? "running" : "completed",
            streaming,
            text,
          },
        },
      ],
    }),
  });
}

const emptyThread = (threadId: string) =>
  appAtomRegistry.set(threadAtom(threadId), {
    status: "live",
    data: Option.some({ runs: [], visibleTurnItems: [] }),
  });

function reset(options: { available?: boolean; seconds?: number } = {}) {
  fake.available = options.available ?? true;
  fake.seconds = options.seconds ?? 0.1;
  fake.spoken.length = 0;
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
}

it("is off until clicked, then plays a streaming reply in order without overlap", async () => {
  reset();
  const starts: Array<{ at: number; duration: number }> = [];
  const start = AudioBufferSourceNode.prototype.start;
  using _start = vi.spyOn(AudioBufferSourceNode.prototype, "start").mockImplementation(function (
    this: AudioBufferSourceNode,
    at = 0,
  ) {
    starts.push({ at, duration: this.buffer!.duration });
    start.call(this, at);
  });
  emptyThread("first");
  await using screen = await render(toggle("first"));
  const button = screen.getByRole("button", { name: "Read replies aloud" });
  await expect.element(button).toHaveAttribute("aria-pressed", "false");
  await button.click();
  await expect.element(button).toHaveAttribute("aria-pressed", "true");

  receive("first", "Hello there. Seco");
  await expect.poll(() => starts.length).toBe(1);
  receive("first", "Hello there. Second one. Run `x` now", false);
  await expect.poll(() => starts.length).toBe(3);
  expect(fake.spoken).toEqual(["Hello there.", "Second one.", "Run now"]);
  for (let index = 1; index < starts.length; index++) {
    const before = starts[index - 1]!;
    expect(starts[index]!.at).toBeGreaterThanOrEqual(before.at + before.duration - 1e-6);
  }

  await button.click();
  await expect.element(button).toHaveAttribute("aria-pressed", "false");
});

it("stays off and says why when there is no key", async () => {
  reset({ available: false });
  using add = vi.spyOn(toastManager, "add");
  emptyThread("keyless");
  await using screen = await render(toggle("keyless"));
  const button = screen.getByRole("button", { name: "Read replies aloud" });
  await button.click();
  await expect
    .poll(() => add.mock.calls.map(([toast]) => toast.title))
    .toContain("No ElevenLabs key found");
  await expect.element(button).toHaveAttribute("aria-pressed", "false");
  receive("keyless", "Nobody hears this. ", false);
  expect(fake.spoken).toEqual([]);
});

it("cuts the playing clip on a thread switch and when the user interrupts", async () => {
  reset({ seconds: 30 });
  using stop = vi.spyOn(AudioBufferSourceNode.prototype, "stop");
  using start = vi.spyOn(AudioBufferSourceNode.prototype, "start");
  emptyThread("left");
  emptyThread("right");
  await using screen = await render(toggle("left"));
  await screen.getByRole("button", { name: "Read replies aloud" }).click();

  receive("left", "From the left. ");
  expect(fake.spoken).toEqual(["From the left."]);
  await expect.poll(() => start.mock.calls.length).toBe(1);
  expect(stop).not.toHaveBeenCalled();
  await screen.rerender(toggle("right"));
  await expect.poll(() => stop.mock.calls.length).toBe(1);
  receive("left", "From the left. Still talking. ");
  receive("right", "From the right. ");
  await expect.poll(() => start.mock.calls.length).toBe(2);
  expect(fake.spoken).toEqual(["From the left.", "From the right."]);

  silenceReadAloud();
  expect(stop).toHaveBeenCalledTimes(2);
  receive("right", "From the right. After the stop. ", false);
  expect(fake.spoken).toEqual(["From the left.", "From the right."]);
});

it("speaks a new thread's first reply while the draft turns into a saved thread", async () => {
  reset();
  emptyThread("draft");
  const header = (isServerThread: boolean) => (
    <ReadAloudToggle
      environmentId={EnvironmentId.make("environment")}
      threadId={ThreadId.make("draft")}
      isServerThread={isServerThread}
    />
  );
  await using screen = await render(header(false));
  await screen.getByRole("button", { name: "Read replies aloud" }).click();
  receive("draft", "First words. ");
  await screen.rerender(header(true));
  await expect.poll(() => fake.spoken).toEqual(["First words."]);
});

it("still plays a clip scheduled right after a stop", async () => {
  reset();
  const player = createAudioPlayer();
  player.unlock();
  const signal = new AbortController().signal;
  await (
    await player.play(silentWave(0.1), signal)
  ).ended;
  await player.play(silentWave(30), signal);
  player.stop();
  const next = await player.play(silentWave(0.1), signal);
  await next.ended;
});
