import * as Schema from "effect/Schema";

/** The most text one synthesis request carries; the provider bills per character. */
export const READ_ALOUD_MAX_REQUEST_CHARS = 500;

export const ReadAloudRequest = Schema.Struct({
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(READ_ALOUD_MAX_REQUEST_CHARS),
  ),
});

export const ReadAloudStatus = Schema.Struct({ available: Schema.Boolean });

export class ReadAloudError extends Schema.TaggedError<ReadAloudError>()(
  "ReadAloudError",
  { reason: Schema.Literals(["missing-key", "rejected-key", "rate-limit", "unavailable"]) },
  { httpApiStatus: 422 },
) {
  override get message() {
    switch (this.reason) {
      case "missing-key":
        return "No ElevenLabs key found";
      case "rejected-key":
        return "ElevenLabs refused the request. Check the key and its credits.";
      case "rate-limit":
        return "ElevenLabs is limiting requests. Try again shortly.";
      case "unavailable":
        return "ElevenLabs could not make the audio.";
    }
  }
}
