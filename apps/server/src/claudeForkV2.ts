import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
import { HostProcessIsExecutable, HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import { decodeClaudeForkPrefix, runClaudeForkWorker } from "./claudeForkTransport.ts";
import { encodeClaudeForkJsonl, prepareClaudeSessionPrefix } from "./claudeSessionFork.ts";
import { stageClaudeForkFile } from "./claudeForkFile.ts";

// Keep SDK process-global history state in the instance's bounded worker.
export const forkClaudeSessionVerified = Effect.fn("forkClaudeSessionVerified")(function* (input: {
  sessionId: string;
  dir: string;
  configDir: string;
  environment: NodeJS.ProcessEnv;
  upToMessageId?: string;
}) {
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const targetSessionId = yield* crypto.randomUUIDv4;
  const requestId = yield* crypto.randomUUIDv4;
  const workerArguments = (yield* HostProcessIsExecutable)
    ? ["__claude-history"]
    : [
        yield* path.fromFileUrl(
          new URL(
            import.meta.url.endsWith(".ts")
              ? "./claude-history-worker.ts"
              : "./claude-history-worker.mjs",
            import.meta.url,
          ),
        ),
      ];
  const text = yield* runClaudeForkWorker(
    ChildProcess.make(
      yield* HostProcessExecutablePath,
      [
        ...workerArguments,
        "readForkPrefix",
        input.sessionId,
        JSON.stringify({
          dir: input.dir,
          upToMessageId: input.upToMessageId,
          targetSessionId,
          requestId,
        }),
      ],
      {
        env: {
          ...input.environment,
          CLAUDE_CONFIG_DIR: input.configDir,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    ),
  );
  const prefix = yield* Effect.try(() =>
    decodeClaudeForkPrefix(text, {
      sourceSessionId: input.sessionId,
      targetSessionId,
      requestId,
      ...(input.upToMessageId === undefined ? {} : { checkpointId: input.upToMessageId }),
    }),
  );
  const prepared = yield* Effect.tryPromise(() =>
    prepareClaudeSessionPrefix(
      prefix.entries,
      input.sessionId,
      prefix.checkpointId,
      targetSessionId,
    ),
  );
  const bytes = yield* Effect.try(() => encodeClaudeForkJsonl(prepared.entries));
  const lease = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      stageClaudeForkFile(input.configDir, prefix.projectKey, targetSessionId, bytes),
    ),
    (owned, exit) => (Exit.isFailure(exit) ? Effect.promise(() => owned.discard()) : Effect.void),
  );
  yield* Effect.tryPromise((signal) => lease.publish(signal));
  return { sessionId: targetSessionId };
}, Effect.scoped);
