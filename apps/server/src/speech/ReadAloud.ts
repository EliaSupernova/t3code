import { ReadAloudError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/http";
import * as ProcessRunner from "../processRunner.ts";

/** The voice "Mark". */
const READ_ALOUD_VOICE_ID = "UgBBYS2sOqTuMpoF3BR0";
const READ_ALOUD_MODEL_ID = "eleven_v4_turbo";
const SYNTHESIS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${READ_ALOUD_VOICE_ID}/stream?output_format=mp3_44100_128`;
const KEY_HEADER = "xi-api-key";
const KEYCHAIN_SERVICE = "elevenlabs-api-key";
const KEY_VARIABLE = "ELEVENLABS_API_KEY";
// A header cannot carry spaces or control characters, and fetch quotes a bad value in its error.
const USABLE_KEY = /^[\x21-\x7e]+$/;

const usableKey = (value: string) => {
  const key = value.trim();
  return USABLE_KEY.test(key) ? Option.some(Redacted.make(key)) : Option.none();
};

export class ReadAloud extends Context.Service<
  ReadAloud,
  {
    /** Whether this machine has an ElevenLabs key. */
    readonly available: Effect.Effect<boolean>;
    /** MP3 audio of `text`. Each call is billed by ElevenLabs. */
    readonly synthesize: (text: string) => Effect.Effect<Uint8Array, ReadAloudError>;
  }
>()("t3/speech/ReadAloud") {}

export const layer = Layer.effect(
  ReadAloud,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const processes = yield* ProcessRunner.ProcessRunner;
    const platform = yield* HostProcess.Platform;
    // Memory only. A key is kept once found; a missing one is looked for again next time.
    const cached = yield* Ref.make(Option.none<Redacted.Redacted<string>>());
    // One lookup at a time, so macOS never shows two Keychain prompts.
    const lookup = yield* Semaphore.make(1);

    const fromKeychain =
      platform !== "darwin"
        ? Effect.succeedNone
        : processes
            .run({
              command: "/usr/bin/security",
              args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
              // Long enough to answer a Keychain permission prompt.
              timeout: "30 seconds",
              maxOutputBytes: 4_096,
            })
            .pipe(
              Effect.map((result) =>
                result.code === 0 ? usableKey(result.stdout) : Option.none(),
              ),
              Effect.orElseSucceed(() => Option.none()),
            );
    const fromEnvironment = Effect.gen(function* () {
      return usableKey(yield* Config.String(KEY_VARIABLE));
    }).pipe(Effect.orElseSucceed(() => Option.none()));
    const readKey = lookup.withPermits(1)(
      Effect.gen(function* () {
        const known = yield* Ref.get(cached);
        if (Option.isSome(known)) return known;
        const keychain = yield* fromKeychain;
        const found = Option.isSome(keychain) ? keychain : yield* fromEnvironment;
        yield* Ref.set(cached, found);
        return found;
      }),
    );

    const synthesize = Effect.fn("ReadAloud.synthesize")(function* (text: string) {
      const key = yield* readKey;
      if (Option.isNone(key)) return yield* new ReadAloudError({ reason: "missing-key" });
      // Upstream errors hold the request and its key, so none of them leaves this function.
      const unavailable = () => new ReadAloudError({ reason: "unavailable" });
      return yield* Effect.gen(function* () {
        const response = yield* http
          .execute(
            HttpClientRequest.post(SYNTHESIS_URL).pipe(
              HttpClientRequest.setHeader(KEY_HEADER, Redacted.value(key.value)),
              HttpClientRequest.bodyJsonUnsafe({ text, model_id: READ_ALOUD_MODEL_ID }),
            ),
          )
          .pipe(Effect.mapError(unavailable));
        if (response.status === 401 || response.status === 403) {
          // The key may have been replaced since it was read.
          yield* Ref.set(cached, Option.none());
          return yield* new ReadAloudError({ reason: "rejected-key" });
        }
        if (response.status === 429) return yield* new ReadAloudError({ reason: "rate-limit" });
        if (response.status < 200 || response.status >= 300) return yield* unavailable();
        const audio = yield* response.arrayBuffer.pipe(Effect.mapError(unavailable));
        return new Uint8Array(audio);
      }).pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(unavailable()),
        }),
        // Tracing records request headers, and `xi-api-key` is not redacted by default.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provideService(Headers.CurrentRedactedNames, [KEY_HEADER, "authorization"]),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      );
    });

    return ReadAloud.of({
      available: readKey.pipe(Effect.map(Option.isSome)),
      synthesize,
    });
  }),
);
