import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadForkInput,
  ThreadId,
  TurnId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";

import { sidechatTargetThreadId } from "./SidechatForker.ts";
import { forkSidechat } from "./SidechatForker.ts";

const SOURCE_THREAD_ID = ThreadId.make("source-thread");
const TARGET_THREAD_ID = sidechatTargetThreadId(SOURCE_THREAD_ID, "retry-1");
const SOURCE_PROVIDER = ProviderDriverKind.make("codex");
const SOURCE_INSTANCE = ProviderInstanceId.make("codex");
const PROJECT_ID = ProjectId.make("project-1");
const SOURCE_TURN_ID = TurnId.make("turn-source");
const SOURCE_ORIGIN = {
  threadId: SOURCE_THREAD_ID,
  turnId: "turn-source",
  createdAt: "2026-09-19T00:00:00.000Z",
} as const;
const TARGET_BINDING = {
  threadId: TARGET_THREAD_ID,
  provider: SOURCE_PROVIDER,
  providerInstanceId: SOURCE_INSTANCE,
  status: "stopped" as const,
  runtimeMode: "full-access" as const,
  resumeCursor: { threadId: "provider-target", sidechat: true },
  runtimePayload: {
    cwd: "C:\\projects\\sidechat",
    sidechatOrigin: SOURCE_ORIGIN,
  },
};

const SOURCE_DETAIL = {
  id: SOURCE_THREAD_ID,
  projectId: PROJECT_ID,
  title: "Source thread",
  modelSelection: undefined,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "C:\\projects\\sidechat",
  origin: null,
  latestTurn: {
    turnId: SOURCE_TURN_ID,
    state: "completed",
    requestedAt: "2026-09-19T00:00:00.000Z",
    startedAt: "2026-09-19T00:00:00.000Z",
    completedAt: "2026-09-19T00:00:01.000Z",
    assistantMessageId: null,
  },
  archivedAt: null,
  deletedAt: null,
  session: null,
} as unknown as OrchestrationThread;
const SOURCE_SHELL = {
  id: SOURCE_THREAD_ID,
  projectId: PROJECT_ID,
  title: "Source thread",
  modelSelection: undefined,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "C:\\projects\\sidechat",
  latestTurn: SOURCE_DETAIL.latestTurn,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  backgroundLiveness: null,
} as unknown as OrchestrationThreadShell;
const PROJECT_SHELL = {
  id: PROJECT_ID,
  workspaceRoot: "C:\\projects\\workspace",
} as unknown as OrchestrationProjectShell;
const SOURCE_BINDING = {
  threadId: SOURCE_THREAD_ID,
  provider: SOURCE_PROVIDER,
  providerInstanceId: SOURCE_INSTANCE,
  status: "stopped" as const,
  runtimeMode: "full-access" as const,
  resumeCursor: { threadId: "provider-source" },
};

function crashWindowLayers(input: {
  readonly projection: Option.Option<unknown>;
  readonly binding: Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>;
  readonly onDispatch?: (command: unknown) => Effect.Effect<void>;
  readonly onDeleteProvider?: () => Effect.Effect<void>;
  readonly onDeleteBinding?: () => Effect.Effect<void>;
}) {
  return Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: (threadId: ThreadId) =>
        Effect.succeed(
          threadId === TARGET_THREAD_ID
            ? (input.projection as Option.Option<OrchestrationThread>)
            : Option.none<OrchestrationThread>(),
        ),
    }),
    Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({
      getBinding: (threadId: ThreadId) =>
        Effect.succeed(threadId === TARGET_THREAD_ID ? input.binding : Option.none()),
      ...(input.onDeleteBinding
        ? { deleteByThreadId: () => input.onDeleteBinding!() }
        : {}),
    }),
    Layer.mock(ProviderService)({
      ...(input.onDeleteProvider
        ? { deleteForkedThread: () => input.onDeleteProvider!() }
        : {}),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        (input.onDispatch?.(command) ?? Effect.void).pipe(Effect.as({ sequence: 1 })),
    }),
    NodeServices.layer,
  );
}

function completeForkLayers(input?: {
  readonly sourceShell?: OrchestrationThreadShell;
  readonly postForkSource?: OrchestrationThread;
  readonly postForkShell?: OrchestrationThreadShell;
  readonly dispatchError?: boolean;
  readonly onDeleteProvider?: () => Effect.Effect<void>;
}) {
  const bindings = new Map<ThreadId, ProviderSessionDirectory.ProviderRuntimeBinding>();
  bindings.set(SOURCE_THREAD_ID, SOURCE_BINDING);
  let detailReads = 0;
  let shellReads = 0;
  const dispatched: Array<unknown> = [];
  let forkCalls = 0;
  let deleteCalls = 0;

  const layers = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: (threadId: ThreadId) => {
        if (threadId.startsWith("sidechat-")) {
          return Effect.succeed(Option.none<OrchestrationThread>());
        }
        detailReads += 1;
        return Effect.succeed(
          Option.some(
            (detailReads >= 2 && input?.postForkSource
              ? input.postForkSource
              : SOURCE_DETAIL) as OrchestrationThread,
          ),
        );
      },
      getThreadShellById: (threadId: ThreadId) => {
        if (threadId.startsWith("sidechat-")) {
          return Effect.succeed(Option.none<OrchestrationThreadShell>());
        }
        shellReads += 1;
        return Effect.succeed(
          Option.some(
            (shellReads >= 2 && input?.postForkShell
              ? input.postForkShell
              : input?.sourceShell ?? SOURCE_SHELL) as OrchestrationThreadShell,
          ),
        );
      },
      getProjectShellById: () => Effect.succeed(Option.some(PROJECT_SHELL)),
    }),
    Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({
      getBinding: (threadId: ThreadId) => {
        const binding = bindings.get(threadId);
        return Effect.succeed(binding === undefined ? Option.none() : Option.some(binding));
      },
      upsert: (binding) =>
        Effect.sync(() => {
          bindings.set(binding.threadId, binding);
        }),
      deleteByThreadId: (threadId: ThreadId) =>
        Effect.sync(() => {
          bindings.delete(threadId);
        }),
    }),
    Layer.mock(ProviderService)({
      getCapabilities: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session" as const,
          supportsThreadFork: true,
        }),
      forkThread: () =>
        Effect.sync(() => {
          forkCalls += 1;
          return {
            providerThreadId: "provider-target",
            resumeCursor: { threadId: "provider-target", sidechat: true },
          };
        }),
      deleteForkedThread: () =>
        Effect.gen(function* () {
          deleteCalls += 1;
          yield* input?.onDeleteProvider?.() ?? Effect.void;
        }),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatched.push(command);
          if (input?.dispatchError) {
            return yield* Effect.fail(new Error("projection dispatch failed") as never);
          }
          return { sequence: 1 };
        }),
    }),
    NodeServices.layer,
  );

  return {
    layers,
    dispatched,
    get forkCalls() {
      return forkCalls;
    },
    get deleteCalls() {
      return deleteCalls;
    },
  };
}

describe("sidechatTargetThreadId", () => {
  it("is stable for a source and request and changes with the request", () => {
    const source = "thread:source" as never;

    const target = sidechatTargetThreadId(source, "request-1");
    expect(target).toMatch(/^sidechat-[0-9a-f]{64}$/);
    expect(target).not.toContain(":");
    expect(sidechatTargetThreadId(source, "request-1")).toBe(
      sidechatTargetThreadId(source, "request-1"),
    );
    expect(sidechatTargetThreadId(source, "request-2")).not.toBe(
      sidechatTargetThreadId(source, "request-1"),
    );
  });

  it("bounds request IDs before they participate in idempotency", () => {
    const decoded = Schema.decodeUnknownOption(ThreadForkInput)({
      sourceThreadId: "thread:source",
      requestId: "x".repeat(257),
    });

    expect(Option.isNone(decoded)).toBe(true);
  });
});

describe("forkSidechat crash-window recovery", () => {
  it.effect("fails and tombstones a projection whose provider binding is missing", () =>
    Effect.gen(function* () {
      const commands: Array<unknown> = [];
      const result = yield* forkSidechat({
        sourceThreadId: SOURCE_THREAD_ID,
        requestId: "retry-1",
      }).pipe(
        Effect.result,
        Effect.provide(
          crashWindowLayers({
            projection: Option.some({ origin: SOURCE_ORIGIN }),
            binding: Option.none(),
            onDispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
              }),
          }),
        ),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ThreadForkFailedError");
      }
      expect(commands).toHaveLength(1);
      expect((commands[0] as { type: string }).type).toBe("thread.delete");
    }),
  );

  it.effect("fails and deletes the exact provider target when its projection is missing", () =>
    Effect.gen(function* () {
      let providerDeleted = 0;
      let bindingDeleted = 0;
      const result = yield* forkSidechat({
        sourceThreadId: SOURCE_THREAD_ID,
        requestId: "retry-1",
      }).pipe(
        Effect.result,
        Effect.provide(
          crashWindowLayers({
            projection: Option.none(),
            binding: Option.some(
              TARGET_BINDING as ProviderSessionDirectory.ProviderRuntimeBinding,
            ),
            onDeleteProvider: () => Effect.sync(() => void providerDeleted++),
            onDeleteBinding: () => Effect.sync(() => void bindingDeleted++),
          }),
        ),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ThreadForkFailedError");
      }
      expect(providerDeleted).toBe(1);
      expect(bindingDeleted).toBe(1);
    }),
  );

  it.effect("only replays an existing target when projection and binding agree", () =>
    Effect.gen(function* () {
      const result = yield* forkSidechat({
        sourceThreadId: SOURCE_THREAD_ID,
        requestId: "retry-1",
      }).pipe(
        Effect.provide(
          crashWindowLayers({
            projection: Option.some({ origin: SOURCE_ORIGIN }),
            binding: Option.some(
              TARGET_BINDING as ProviderSessionDirectory.ProviderRuntimeBinding,
            ),
          }),
        ),
      );

      expect(result).toEqual({
        targetThreadId: TARGET_THREAD_ID,
        origin: SOURCE_ORIGIN,
      });
    }),
  );

  it.effect("tombstones a visible target whose matching binding lost its cursor", () =>
    Effect.gen(function* () {
      const commands: Array<unknown> = [];
      let bindingDeleted = 0;
      const result = yield* forkSidechat({
        sourceThreadId: SOURCE_THREAD_ID,
        requestId: "retry-1",
      }).pipe(
        Effect.result,
        Effect.provide(
          crashWindowLayers({
            projection: Option.some({ origin: SOURCE_ORIGIN }),
            binding: Option.some({
              ...TARGET_BINDING,
              resumeCursor: null,
            } as ProviderSessionDirectory.ProviderRuntimeBinding),
            onDispatch: (command) => Effect.sync(() => void commands.push(command)),
            onDeleteBinding: () => Effect.sync(() => void bindingDeleted++),
          }),
        ),
      );

      expect(result._tag).toBe("Failure");
      expect(commands).toHaveLength(1);
      expect((commands[0] as { type: string }).type).toBe("thread.delete");
      expect(bindingDeleted).toBe(1);
    }),
  );
});

describe("forkSidechat guards and cleanup", () => {
  it.effect("creates the provider binding before publishing the visible target", () =>
    Effect.gen(function* () {
      const harness = completeForkLayers();
      const result = yield* forkSidechat({
        sourceThreadId: SOURCE_THREAD_ID,
        requestId: "request-success",
      }).pipe(Effect.provide(harness.layers));

      expect(result.targetThreadId).toBe(sidechatTargetThreadId(SOURCE_THREAD_ID, "request-success"));
      expect(result.origin.threadId).toBe(SOURCE_THREAD_ID);
      expect(harness.forkCalls).toBe(1);
      expect(harness.dispatched).toHaveLength(1);
      expect((harness.dispatched[0] as { type: string }).type).toBe("thread.create");
    }),
  );

  it.effect("rejects pending source input before invoking the native provider fork", () =>
    Effect.gen(function* () {
      const harness = completeForkLayers({
        sourceShell: { ...SOURCE_SHELL, hasPendingApprovals: true },
      });
      const result = yield* forkSidechat({
        sourceThreadId: SOURCE_THREAD_ID,
        requestId: "request-busy",
      }).pipe(Effect.result, Effect.provide(harness.layers));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ThreadForkSourceBusyError");
      }
      expect(harness.forkCalls).toBe(0);
    }),
  );

  it.effect("deletes the native target when the source advances during the fork", () =>
    Effect.gen(function* () {
      const advancedSource = {
        ...SOURCE_DETAIL,
        latestTurn: { ...SOURCE_DETAIL.latestTurn, turnId: TurnId.make("turn-new") },
      } as OrchestrationThread;
      const harness = completeForkLayers({ postForkSource: advancedSource });
      const result = yield* forkSidechat({
        sourceThreadId: SOURCE_THREAD_ID,
        requestId: "request-advanced",
      }).pipe(Effect.result, Effect.provide(harness.layers));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ThreadForkFailedError");
      }
      expect(harness.deleteCalls).toBe(1);
      expect(harness.dispatched).toHaveLength(0);
    }),
  );

  it.effect("deletes the native target when publishing the visible target fails", () =>
    Effect.gen(function* () {
      const harness = completeForkLayers({ dispatchError: true });
      const result = yield* forkSidechat({
        sourceThreadId: SOURCE_THREAD_ID,
        requestId: "request-dispatch-failure",
      }).pipe(Effect.result, Effect.provide(harness.layers));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ThreadForkFailedError");
      }
      expect(harness.deleteCalls).toBe(1);
      expect(harness.dispatched).toHaveLength(1);
      expect((harness.dispatched[0] as { type: string }).type).toBe("thread.create");
    }),
  );
});
