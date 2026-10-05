import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { collectUint8StreamText } from "./stream/collectUint8StreamText.ts";

// Deliberate transport ceiling; larger transcripts fail rather than truncate.
export const CLAUDE_FORK_OUTPUT_LIMIT = 32 * 1024 * 1024;
export const CLAUDE_FORK_STDERR_LIMIT = 64 * 1024;

export class ClaudeForkTransportError extends Schema.TaggedError<ClaudeForkTransportError>()(
  "ClaudeForkTransportError",
  {
    message: Schema.String,
    forkFailureReason: Schema.optional(Schema.Literals(["unsupported-format", "size-limit"])),
  },
) {}

const decodePrefix = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        sourceSessionId: Schema.String,
        targetSessionId: Schema.String,
        checkpointId: Schema.String,
        requestId: Schema.String,
        projectKey: Schema.String,
        compacted: Schema.Boolean,
        entries: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      }),
      Schema.Struct({
        sourceSessionId: Schema.String,
        targetSessionId: Schema.String,
        checkpointId: Schema.String,
        requestId: Schema.String,
        forkFailureReason: Schema.Literals(["unsupported-format", "size-limit"]),
      }),
    ]),
  ),
);

export function decodeClaudeForkPrefix(
  text: string,
  expected: {
    sourceSessionId: string;
    targetSessionId: string;
    checkpointId?: string;
    requestId: string;
  },
) {
  if (Buffer.byteLength(text, "utf8") > CLAUDE_FORK_OUTPUT_LIMIT) {
    throw new ClaudeForkTransportError({
      message: "Claude fork output limit exceeded.",
      forkFailureReason: "size-limit",
    });
  }
  const result = decodePrefix(text);
  if (
    result.sourceSessionId !== expected.sourceSessionId ||
    result.targetSessionId !== expected.targetSessionId ||
    (expected.checkpointId !== undefined && result.checkpointId !== expected.checkpointId) ||
    result.requestId !== expected.requestId
  ) {
    throw new ClaudeForkTransportError({ message: "Claude fork response binding mismatch." });
  }
  if ("forkFailureReason" in result) {
    throw new ClaudeForkTransportError({
      message: "Claude fork rejected.",
      forkFailureReason: result.forkFailureReason,
    });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(result.projectKey))
    throw new ClaudeForkTransportError({ message: "Invalid Claude fork project key." });
  const entries = result.entries.map((entry) => {
    if (typeof entry.type !== "string")
      throw new ClaudeForkTransportError({ message: "Invalid Claude fork transcript entry." });
    return { ...entry, type: entry.type };
  });
  return { ...result, entries };
}

export const runClaudeForkWorker = Effect.fn("runClaudeForkWorker")(
  function* (command: ChildProcess.Command) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const [stdout, , code] = yield* Effect.all(
      [
        collectClaudeForkOutput(child.stdout, CLAUDE_FORK_OUTPUT_LIMIT),
        collectClaudeForkOutput(child.stderr, CLAUDE_FORK_STDERR_LIMIT),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (Number(code) !== 0)
      return yield* new ClaudeForkTransportError({ message: "Claude fork worker failed." });
    return stdout;
  },
  Effect.scoped,
  Effect.timeout("30 seconds"),
);

export const collectClaudeForkOutput = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  maxBytes: number,
) =>
  Effect.suspend(() => {
    let bytes = 0;
    return collectUint8StreamText({
      stream: stream.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength;
          return bytes > maxBytes
            ? Effect.fail(
                new ClaudeForkTransportError({
                  message: "Claude fork output limit exceeded.",
                  forkFailureReason: "size-limit",
                }),
              )
            : Effect.succeed(chunk);
        }),
      ),
      maxBytes,
    }).pipe(
      Effect.flatMap((result) =>
        result.invalidUtf8
          ? Effect.fail(
              new ClaudeForkTransportError({ message: "Invalid Claude fork UTF-8 output." }),
            )
          : Effect.succeed(result.text),
      ),
    );
  });
