import {
  CommandId,
  ThreadForkFailedError,
  ThreadForkSourceBusyError,
  ThreadForkSourceNotFoundError,
  ThreadForkUnsupportedError,
  ThreadOrigin,
  type ThreadForkInput,
  type ThreadId,
} from "@t3tools/contracts";
import { createHash } from "node:crypto";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";

/** Request-scoped identity: retries cannot create a second visible thread. */
export function sidechatTargetThreadId(sourceThreadId: ThreadId, requestId: string): ThreadId {
  const digest = createHash("sha256")
    .update(sourceThreadId + "\u0000" + requestId, "utf8")
    .digest("hex");
  return ("sidechat-" + digest) as ThreadId;
}

// Native provider forks are not transactional with the T3 projection. One
// process-wide gate ensures two retries cannot race and clean up each other's
// provider binding while the projection is catching up.
const sidechatForkMutex = Semaphore.makeUnsafe(1);
const SidechatRuntimePayloadSchema = Schema.Struct({
  sidechatOrigin: ThreadOrigin,
  cwd: Schema.optional(Schema.String),
});

/**
 * Fork a completed provider conversation, then publish the empty T3 target.
 * The provider cursor is installed before the event so restart recovery can
 * never manufacture a blank provider thread.
 */
const forkSidechatUnlocked = Effect.fn("forkSidechatUnlocked")(function* (
  input: ThreadForkInput,
) {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const providers = yield* ProviderService.ProviderService;
  const crypto = yield* Crypto.Crypto;
  const targetThreadId = sidechatTargetThreadId(input.sourceThreadId, input.requestId);
  const existingTarget = yield* snapshots.getThreadDetailById(targetThreadId);
  const existingTargetBinding = yield* directory.getBinding(targetThreadId);

  const failForCorruptTarget = (cause: unknown) =>
    Effect.fail(
      new ThreadForkFailedError({
        sourceThreadId: input.sourceThreadId,
        cause,
      }),
    );

  const tombstoneProjection = Effect.gen(function* () {
    yield* engine
      .dispatch({
        type: "thread.delete",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId: targetThreadId,
      })
      .pipe(Effect.ignore);
  });

  const cleanupPersistedBinding = (
    binding: ProviderSessionDirectory.ProviderRuntimeBinding,
  ) =>
    Effect.gen(function* () {
      const payload = Schema.decodeUnknownOption(SidechatRuntimePayloadSchema)(
        binding.runtimePayload,
      );
      if (
        Option.isNone(payload) ||
        binding.resumeCursor == null ||
        binding.providerInstanceId === undefined ||
        payload.value.cwd === undefined
      ) {
        return;
      }
      if (providers.deleteForkedThread !== undefined) {
        yield* providers
          .deleteForkedThread({
            threadId: targetThreadId,
            providerInstanceId: binding.providerInstanceId,
            resumeCursor: binding.resumeCursor,
            cwd: payload.value.cwd,
            runtimeMode: binding.runtimeMode ?? "full-access",
          })
          .pipe(Effect.ignore);
      }
      if (directory.deleteByThreadId !== undefined) {
        yield* directory.deleteByThreadId(targetThreadId).pipe(Effect.ignore);
      }
    });

  if (Option.isSome(existingTarget)) {
    const storedOrigin = existingTarget.value.origin;
    if (storedOrigin?.threadId === input.sourceThreadId) {
      if (Option.isNone(existingTargetBinding)) {
        yield* tombstoneProjection;
        return yield* failForCorruptTarget(
          new Error("Sidechat target projection exists without its provider binding."),
        );
      }
      const bindingOrigin = Schema.decodeUnknownOption(SidechatRuntimePayloadSchema)(
        existingTargetBinding.value.runtimePayload,
      );
      if (
        Option.isSome(bindingOrigin) &&
        bindingOrigin.value.sidechatOrigin.threadId === input.sourceThreadId &&
        existingTargetBinding.value.resumeCursor != null &&
        existingTargetBinding.value.providerInstanceId !== undefined
      ) {
        return { targetThreadId, origin: storedOrigin };
      }
      if (
        Option.isSome(bindingOrigin) &&
        bindingOrigin.value.sidechatOrigin.threadId === input.sourceThreadId
      ) {
        yield* tombstoneProjection;
        if (directory.deleteByThreadId !== undefined) {
          yield* directory.deleteByThreadId(targetThreadId).pipe(Effect.ignore);
        }
        return yield* failForCorruptTarget(
          new Error("Sidechat target binding is missing its provider resume state."),
        );
      }
      return yield* failForCorruptTarget(
        new Error("Sidechat target projection and provider binding do not agree."),
      );
    }
    return yield* failForCorruptTarget(new Error("Deterministic sidechat target is already in use."));
  }
  if (Option.isSome(existingTargetBinding)) {
    const storedOrigin = Schema.decodeUnknownOption(SidechatRuntimePayloadSchema)(
      existingTargetBinding.value.runtimePayload,
    );
    if (
      Option.isSome(storedOrigin) &&
      storedOrigin.value.sidechatOrigin.threadId === input.sourceThreadId
    ) {
      // The provider fork succeeded but the projection event did not. Do not
      // report success for an invisible target; remove the exact provider
      // resource and directory row so a retry can safely start over.
      yield* cleanupPersistedBinding(existingTargetBinding.value);
      return yield* failForCorruptTarget(
        new Error("Sidechat target provider binding exists without its projection."),
      );
    }
    return yield* failForCorruptTarget(
      new Error("Deterministic sidechat provider binding is already in use."),
    );
  }
  const sourceOption = yield* snapshots.getThreadDetailById(input.sourceThreadId);
  if (Option.isNone(sourceOption)) {
    return yield* new ThreadForkSourceNotFoundError({ sourceThreadId: input.sourceThreadId });
  }
  const source = sourceOption.value;
  const sourceShellOption = yield* snapshots.getThreadShellById(input.sourceThreadId);
  if (Option.isNone(sourceShellOption)) {
    return yield* new ThreadForkSourceNotFoundError({ sourceThreadId: input.sourceThreadId });
  }
  const sourceShell = sourceShellOption.value;
  const latestTurn = source.latestTurn;
  if (source.archivedAt !== null || source.deletedAt !== null) {
    return yield* new ThreadForkSourceBusyError({
      sourceThreadId: input.sourceThreadId,
      reason: "the source thread is archived or deleted",
    });
  }
  if (latestTurn === null || latestTurn.state !== "completed" || latestTurn.completedAt === null) {
    return yield* new ThreadForkSourceBusyError({
      sourceThreadId: input.sourceThreadId,
      reason: "the source thread does not have a completed latest turn",
    });
  }
  if (source.session?.activeTurnId !== null && source.session?.activeTurnId !== undefined) {
    return yield* new ThreadForkSourceBusyError({
      sourceThreadId: input.sourceThreadId,
      reason: "a provider turn is still active",
    });
  }
  if (sourceShell.hasPendingApprovals || sourceShell.hasPendingUserInput) {
    return yield* new ThreadForkSourceBusyError({
      sourceThreadId: input.sourceThreadId,
      reason: "the source thread has pending input",
    });
  }
  if (sourceShell.backgroundLiveness !== null && sourceShell.backgroundLiveness !== undefined) {
    return yield* new ThreadForkSourceBusyError({
      sourceThreadId: input.sourceThreadId,
      reason: "background provider work is still active",
    });
  }

  const origin = {
    threadId: input.sourceThreadId,
    turnId: latestTurn.turnId,
    createdAt: DateTime.formatIso(yield* DateTime.now),
  } as const;
  const bindingOption = yield* directory.getBinding(input.sourceThreadId);
  if (Option.isNone(bindingOption) || bindingOption.value.resumeCursor == null) {
    return yield* new ThreadForkFailedError({
      sourceThreadId: input.sourceThreadId,
      cause: new Error("No persisted provider resume cursor exists."),
    });
  }
  const binding = bindingOption.value;
  const providerInstanceId = binding.providerInstanceId;
  if (providerInstanceId === undefined) {
    return yield* new ThreadForkFailedError({
      sourceThreadId: input.sourceThreadId,
      cause: new Error("Provider instance id is missing."),
    });
  }
  const capabilities = yield* providers.getCapabilities(providerInstanceId).pipe(
    Effect.catch((cause) =>
      Effect.fail(new ThreadForkFailedError({ sourceThreadId: input.sourceThreadId, cause })),
    ),
  );
  if (capabilities.supportsThreadFork !== true) {
    return yield* new ThreadForkUnsupportedError({ provider: binding.provider });
  }
  const nativeFork = providers.forkThread;
  if (nativeFork === undefined) {
    return yield* new ThreadForkUnsupportedError({ provider: binding.provider });
  }

  const projectOption = yield* snapshots.getProjectShellById(source.projectId);
  if (Option.isNone(projectOption)) {
    return yield* new ThreadForkFailedError({
      sourceThreadId: input.sourceThreadId,
      cause: new Error(`Project '${source.projectId}' was not found.`),
    });
  }
  const workspaceRoot = projectOption.value.workspaceRoot;
  const cwd = source.worktreePath ?? workspaceRoot;
  const forked = yield* nativeFork({
      sourceThreadId: input.sourceThreadId,
      targetThreadId,
      lastTurnId: latestTurn.turnId,
      cwd,
      runtimeMode: source.runtimeMode,
      modelSelection: source.modelSelection,
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.fail(new ThreadForkFailedError({ sourceThreadId: input.sourceThreadId, cause })),
      ),
    );

  const cleanup = (cause: unknown) =>
    Effect.gen(function* () {
      if (providers.deleteForkedThread !== undefined) {
        yield* providers
          .deleteForkedThread({
            threadId: targetThreadId,
            providerInstanceId,
            resumeCursor: forked.resumeCursor,
            cwd,
            runtimeMode: source.runtimeMode,
            modelSelection: source.modelSelection,
          })
          .pipe(Effect.ignore);
      }
      if (directory.deleteByThreadId !== undefined) {
        yield* directory.deleteByThreadId(targetThreadId).pipe(Effect.ignore);
      }
      return yield* new ThreadForkFailedError({ sourceThreadId: input.sourceThreadId, cause });
    });

  const postForkSourceOption = yield* snapshots.getThreadDetailById(input.sourceThreadId).pipe(
    Effect.catch(cleanup),
  );
  const postForkSourceShellOption = yield* snapshots
    .getThreadShellById(input.sourceThreadId)
    .pipe(Effect.catch(cleanup));
  if (Option.isNone(postForkSourceOption) || Option.isNone(postForkSourceShellOption)) {
    return yield* cleanup(new Error("Source thread disappeared while the native fork was running."));
  }
  const postForkSource = postForkSourceOption.value;
  const postForkSourceShell = postForkSourceShellOption.value;
  const postForkLatestTurn = postForkSource.latestTurn;
  const postForkReason =
    postForkSource.archivedAt !== null || postForkSource.deletedAt !== null
      ? "the source thread was archived or deleted during the fork"
      : postForkLatestTurn === null ||
          postForkLatestTurn.state !== "completed" ||
          postForkLatestTurn.completedAt === null
        ? "the source thread no longer has a completed latest turn"
        : postForkLatestTurn.turnId !== latestTurn.turnId
          ? "the source thread advanced while the fork was running"
          : postForkSource.session?.activeTurnId !== null &&
              postForkSource.session?.activeTurnId !== undefined
            ? "a provider turn became active during the fork"
            : postForkSourceShell.hasPendingApprovals || postForkSourceShell.hasPendingUserInput
              ? "the source thread received pending input during the fork"
              : postForkSourceShell.backgroundLiveness !== null &&
                  postForkSourceShell.backgroundLiveness !== undefined
                ? "background provider work became active during the fork"
                : postForkSource.projectId !== source.projectId ||
                    postForkSource.worktreePath !== source.worktreePath
                  ? "the source project or worktree changed during the fork"
                  : undefined;
  if (postForkReason !== undefined) {
    return yield* cleanup(new Error(postForkReason));
  }
  const postForkProjectOption = yield* snapshots
    .getProjectShellById(postForkSource.projectId)
    .pipe(Effect.catch(cleanup));
  if (
    Option.isNone(postForkProjectOption) ||
    postForkProjectOption.value.workspaceRoot !== projectOption.value.workspaceRoot
  ) {
    return yield* cleanup(new Error("The source project workspace changed during the fork."));
  }

  yield* directory
    .upsert(
      {
        threadId: targetThreadId,
        provider: binding.provider,
        providerInstanceId,
        status: "stopped",
        runtimeMode: source.runtimeMode,
        resumeCursor: forked.resumeCursor,
        runtimePayload: { cwd, sidechatOrigin: origin },
      },
      { onConflict: "ignore" },
    )
    .pipe(Effect.catch(cleanup));

  yield* engine
    .dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId: targetThreadId,
      projectId: source.projectId,
      title: `Sidechat: ${source.title}`,
      modelSelection: source.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      branch: source.branch,
      worktreePath: source.worktreePath,
      origin,
      createdAt: origin.createdAt,
    })
    .pipe(Effect.catch(cleanup));

  return { targetThreadId, origin };
});

export const forkSidechat = (input: ThreadForkInput) =>
  sidechatForkMutex.withPermit(forkSidechatUnlocked(input));
