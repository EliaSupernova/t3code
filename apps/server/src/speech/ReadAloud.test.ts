import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Inspectable from "effect/Inspectable";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ChildProcessSpawner } from "effect/process";
import { expect, vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as ReadAloud from "./ReadAloud.ts";

const KEYCHAIN_KEY = "sk_fake_keychain_0123456789";
const ENVIRONMENT_KEY = "sk_fake_environment_9876543210";

const keychainResult = (code: number, stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** A server on `platform` with a fake Keychain, a fake ElevenLabs and no real network. */
const setup = (options: {
  readonly platform?: NodeJS.Platform;
  readonly keychain?: () => ProcessRunner.ProcessRunOutput;
  readonly environment?: Record<string, string>;
  readonly respond?: () => Response;
}) => {
  const keychain = vi.fn(options.keychain ?? (() => keychainResult(44, "")));
  // `run` builds the effect; `keychain` counts the times it actually ran.
  const run = vi.fn((_input: ProcessRunner.ProcessRunInput) => Effect.sync(keychain));
  const upstream = vi.fn<typeof fetch>(async () =>
    options.respond ? options.respond() : new Response(new Uint8Array([1, 2, 3])),
  );
  const service = ReadAloud.ReadAloud.pipe(
    Effect.provide(
      ReadAloud.layer.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({ run })),
        Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "darwin")),
      ),
    ),
  );
  const isolated = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.Fetch, upstream),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.environment ?? {} })),
      ),
    );
  return { run, keychain, upstream, service, isolated };
};

const requestHeader = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

it.effect("sends the sentence to the streaming endpoint with the Keychain key", () => {
  const fake = setup({
    keychain: () => keychainResult(0, `${KEYCHAIN_KEY}\n`),
    environment: { ELEVENLABS_API_KEY: ENVIRONMENT_KEY },
  });
  return fake.isolated(
    Effect.gen(function* () {
      const readAloud = yield* fake.service;
      expect(yield* readAloud.available).toBe(true);
      expect(yield* readAloud.synthesize("Hello there.")).toEqual(new Uint8Array([1, 2, 3]));
      yield* readAloud.synthesize("Again.");

      expect(fake.upstream).toHaveBeenCalledTimes(2);
      const [url, init] = fake.upstream.mock.calls[0]!;
      expect(String(url)).toBe(
        "https://api.elevenlabs.io/v1/text-to-speech/UgBBYS2sOqTuMpoF3BR0/stream?output_format=mp3_44100_128",
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(requestHeader(init, "xi-api-key")).toBe(KEYCHAIN_KEY);
      expect(requestHeader(init, "content-type")).toBe("application/json");
      expect(requestHeader(init, "traceparent")).toBeNull();
      expect(yield* Effect.promise(() => new Response(init?.body).json())).toEqual({
        text: "Hello there.",
        model_id: "eleven_v4_turbo",
      });

      // Read once, then kept in memory.
      expect(fake.keychain).toHaveBeenCalledTimes(1);
      expect(fake.run.mock.calls[0]![0]).toMatchObject({
        command: "/usr/bin/security",
        args: ["find-generic-password", "-s", "elevenlabs-api-key", "-w"],
      });
    }),
  );
});

it.effect("falls back to the environment variable when the Keychain has no key", () => {
  const fake = setup({ environment: { ELEVENLABS_API_KEY: ENVIRONMENT_KEY } });
  return fake.isolated(
    Effect.gen(function* () {
      const readAloud = yield* fake.service;
      yield* readAloud.synthesize("Hi.");
      expect(fake.keychain).toHaveBeenCalledTimes(1);
      expect(requestHeader(fake.upstream.mock.calls[0]![1], "xi-api-key")).toBe(ENVIRONMENT_KEY);
    }),
  );
});

it.effect("never calls the Keychain outside macOS", () => {
  const fake = setup({ platform: "linux", environment: { ELEVENLABS_API_KEY: ENVIRONMENT_KEY } });
  return fake.isolated(
    Effect.gen(function* () {
      const readAloud = yield* fake.service;
      yield* readAloud.synthesize("Hi.");
      expect(fake.run).not.toHaveBeenCalled();
      expect(fake.upstream).toHaveBeenCalledTimes(1);
    }),
  );
});

it.effect.each([
  ["none anywhere", {}],
  ["a blank one", { ELEVENLABS_API_KEY: "  " }],
  ["one a header cannot carry", { ELEVENLABS_API_KEY: "bad\nkey" }],
] as const)("reports a missing key and calls nothing with %s", ([, environment]) => {
  const fake = setup({ environment });
  return fake.isolated(
    Effect.gen(function* () {
      const readAloud = yield* fake.service;
      expect(yield* readAloud.available).toBe(false);
      const error = yield* Effect.flip(readAloud.synthesize("Hi."));
      expect(error).toMatchObject({ reason: "missing-key", message: "No ElevenLabs key found" });
      expect(fake.upstream).not.toHaveBeenCalled();
    }),
  );
});

it.effect("finds a key added after a first miss", () => {
  let stored = "";
  const fake = setup({ keychain: () => keychainResult(stored ? 0 : 44, stored) });
  return fake.isolated(
    Effect.gen(function* () {
      const readAloud = yield* fake.service;
      expect(yield* readAloud.available).toBe(false);
      stored = KEYCHAIN_KEY;
      expect(yield* readAloud.available).toBe(true);
    }),
  );
});

it.effect.each([
  [401, "rejected-key"],
  [403, "rejected-key"],
  [429, "rate-limit"],
  [500, "unavailable"],
] as const)("maps an ElevenLabs %i to %s without its body or the key", ([status, reason]) => {
  const fake = setup({
    keychain: () => keychainResult(0, KEYCHAIN_KEY),
    respond: () => new Response(`upstream detail ${KEYCHAIN_KEY}`, { status }),
  });
  return fake.isolated(
    Effect.gen(function* () {
      const readAloud = yield* fake.service;
      const cause = yield* readAloud.synthesize("Hi.").pipe(Effect.sandbox, Effect.flip);
      expect(Cause.squash(cause)).toMatchObject({ reason });
      expect(Cause.pretty(cause) + Inspectable.toStringUnknown(cause)).not.toMatch(
        /sk_fake|upstream detail/,
      );
      // A rejected key is read again; any other failure keeps it.
      yield* Effect.flip(readAloud.synthesize("Hi."));
      expect(fake.keychain).toHaveBeenCalledTimes(reason === "rejected-key" ? 2 : 1);
    }),
  );
});

it.effect("keeps the key out of traces and network errors", () => {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  let fail = false;
  const fake = setup({
    keychain: () => keychainResult(0, KEYCHAIN_KEY),
    respond: () => {
      if (fail) throw new TypeError(`connect failed for ${KEYCHAIN_KEY}`);
      return new Response(new Uint8Array([1]));
    },
  });
  return fake.isolated(
    Effect.gen(function* () {
      const readAloud = yield* fake.service;
      yield* readAloud.synthesize("Hi.");
      fail = true;
      const cause = yield* readAloud.synthesize("Hi.").pipe(Effect.sandbox, Effect.flip);
      expect(Cause.squash(cause)).toMatchObject({ reason: "unavailable" });

      expect(spans.map((span) => span.name)).toEqual([
        "ReadAloud.synthesize",
        "ReadAloud.synthesize",
      ]);
      const recorded = spans.map((span) =>
        Inspectable.toStringUnknown([
          [...span.attributes],
          span.events,
          span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
            ? Cause.pretty(span.status.exit.cause)
            : "",
        ]),
      );
      expect(recorded.join() + Cause.pretty(cause)).not.toContain("sk_fake");
    }).pipe(Effect.provideService(Tracer.Tracer, tracer)),
  );
});
