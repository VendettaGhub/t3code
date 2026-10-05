import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const forkCases = (["codex", "claudeAgent"] as const).flatMap((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapterV2Shape = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { runEffectWorker: false },
  );

  return (["failed", "interrupted", "cancelled", "completed"] as const).flatMap((status) =>
    (status === "completed" ? [false, true] : [false]).map((nativeBoundary) => ({
      driver,
      status,
      instanceId,
      modelSelection,
      layer,
      nativeBoundary,
    })),
  );
});

it.effect.each(forkCases)(
  "bounds $driver context from $status (native boundary: $nativeBoundary)",
  ({ driver, status, instanceId, modelSelection, layer, nativeBoundary }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-boundary-source");
      const targetThreadId = ThreadId.make("fork-boundary-target");
      const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
      const sourceRunId = RunId.make("fork-boundary-source-run");
      const attemptId = RunAttemptId.make("interrupted-source-attempt");
      const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
      const rootNodeId = NodeId.make("interrupted-source-root");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      // A cancelled queue entry has no provider turn; an early interruption
      // can have a turn but no native assistant cursor.
      if (status === "interrupted" || nativeBoundary) {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-attempt"),
              type: "run-attempt.created",
              threadId: sourceThreadId,
              runId: sourceRunId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: sourceRunId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated",
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: nativeBoundary ? "native-checkpoint" : "turn:synthetic",
                  strength: "weak",
                },
                ordinal: 1,
                status,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
      }
      for (const ordinal of [1, 2]) {
        const runId = ordinal === 1 ? sourceRunId : RunId.make("later-run");
        const messageId = MessageId.make(`source-message-${ordinal}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${ordinal}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId:
                  ordinal === 1 && (status === "interrupted" || nativeBoundary) ? attemptId : null,
                status: ordinal === 1 ? status : "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${ordinal}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${ordinal}`),
                threadId: sourceThreadId,
                runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: ordinal === 1 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                attachments: [],
              },
            },
          ],
        });
      }
      const sidechatExit = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.fork",
          sidechat: true,
          commandId: CommandId.make("reject-portable-sidechat"),
          sourceThreadId,
          targetThreadId: ThreadId.make("rejected-sidechat"),
          sourcePoint: { type: "run", runId: sourceRunId },
          createdBy: "user",
          creationSource: "web",
        }),
      );
      assert.equal(Exit.isFailure(sidechatExit), !nativeBoundary);
      if (nativeBoundary) {
        const sidechatId = ThreadId.make("rejected-sidechat");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("exact-sidechat-send"),
          threadId: sidechatId,
          messageId: MessageId.make("sidechat-question"),
          text: "Side question only",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const child = yield* orchestrator.getThreadProjection(sidechatId);
        assert.isTrue(child.thread.sidechat);
        assert.deepEqual(child.providerThreads[0]?.forkedFrom, {
          providerThreadId,
          providerTurnId,
        });
        // The effect worker is paused; provider execution has not happened yet.
        assert.isNull(child.contextTransfers[0]?.resolution);
        assert.lengthOf(child.contextHandoffs, 0);
        assert.deepEqual(
          child.messages.map(({ text }) => text),
          ["Side question only"],
        );
        const source = yield* orchestrator.getThreadProjection(sourceThreadId);
        assert.deepEqual(
          source.turnItems.map((item) => ("text" in item ? item.text : null)),
          ["INCLUDED_SOURCE_MARKER", "EXCLUDED_LATER_MARKER"],
        );
        return;
      }
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-source"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      const targetBeforeSend = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.lengthOf(targetBeforeSend.messages, 0);
      // An already-persisted sidechat must recheck the source at first send,
      // rather than trust a creation-time capability decision.
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("persist-sidechat-marker"),
            type: "thread.created",
            threadId: targetThreadId,
            occurredAt: now,
            payload: { ...targetBeforeSend.thread, sidechat: true },
          },
        ],
      });
      const firstSend = yield* Effect.exit(
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("reject-sidechat-first-send"),
          threadId: targetThreadId,
          messageId: MessageId.make("rejected-sidechat-question"),
          text: "Must not become a portable sidechat",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }),
      );
      assert.isTrue(Exit.isFailure(firstSend));
      assert.lengthOf((yield* orchestrator.getThreadProjection(targetThreadId)).messages, 0);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("restore-ordinary-fork-marker"),
            type: "thread.created",
            threadId: targetThreadId,
            occurredAt: now,
            payload: targetBeforeSend.thread,
          },
        ],
      });
      if (status === "completed") return;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-fork"),
        text: "Continue from the selected source run",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.lengthOf(target.contextHandoffs, 1);
      const handoff = target.contextHandoffs[0]!;
      const history = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.isNull(target.providerThreads[0]?.forkedFrom);
    }).pipe(Effect.provide(layer)),
);
