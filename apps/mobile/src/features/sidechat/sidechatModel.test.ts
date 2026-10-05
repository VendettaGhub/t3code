import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnId } from "@t3tools/contracts";

import {
  canCompleteSideQuestion,
  canStartSidechat,
  formatSidechatOrigin,
  resolveSidechatParent,
  shouldTransferSideQuestionDraft,
  sidechatChildren,
  supportsNativeThreadFork,
} from "./sidechatModel";

describe("mobile sidechat model", () => {
  it("keeps sidechats attached to their source thread", () => {
    const children = sidechatChildren("main", [
      { id: "first", origin: { threadId: "main" } },
      { id: "other", origin: { threadId: "different" } },
      { id: "second", origin: { threadId: "main" } },
    ]);

    expect(children.map((thread) => thread.id)).toEqual(["first", "second"]);
  });

  it("refuses to open a sidechat when its parent no longer exists", () => {
    expect(resolveSidechatParent({ threadId: "missing" }, [{ id: "main" }])).toBeNull();
  });

  it("allows completed, idle sources when the backend advertises native fork support", () => {
    expect(
      canStartSidechat({
        supportsThreadFork: true,
        parent: {
          latestTurn: { state: "completed" },
          activeTurnId: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        },
      }).allowed,
    ).toBe(true);
  });

  it("delegates completed-checkpoint selection while the latest turn is running with pending approval", () => {
    expect(
      canStartSidechat({
        supportsThreadFork: true,
        parent: {
          latestTurn: { state: "running" },
          activeTurnId: "running-turn",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
        },
      }),
    ).toEqual({ allowed: true, reason: null });
  });

  it.each(["working", "monitoring"] as const)(
    "allows a completed checkpoint with %s background work",
    (backgroundLiveness) => {
      expect(
        canStartSidechat({
          supportsThreadFork: true,
          parent: {
            latestTurn: { state: "completed" },
            activeTurnId: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            backgroundLiveness,
          },
        }),
      ).toEqual({ allowed: true, reason: null });
    },
  );

  it.each([
    ["missing parent", null, true, "The source thread is no longer available."],
    ["unsupported capability", "idle", false, "This provider does not support native sidechats."],
    ["no turns", "empty", true, "Complete a source turn before starting a side question."],
  ] as const)("guards %s", (_name, parentKind, supportsThreadFork, reason) => {
    const result = canStartSidechat({
      supportsThreadFork,
      parent:
        parentKind === null
          ? null
          : {
              latestTurn: parentKind === "empty" ? null : { state: "completed" },
              activeTurnId: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
            },
    });

    expect(result).toEqual({ allowed: false, reason });
  });

  it("follows the backend capability for every provider", () => {
    expect(supportsNativeThreadFork(true)).toBe(true);
    expect(supportsNativeThreadFork(false)).toBe(false);
    expect(supportsNativeThreadFork(undefined)).toBe(false);
  });

  it.each([
    [null, false],
    ["inspect the child", true],
  ] as const)("only /btw text transfers the owner draft (%s)", (question, transfers) => {
    expect(shouldTransferSideQuestionDraft(question)).toBe(transfers);
  });

  it.each([
    ["unmounted", false, true, "env:thread", 4, 4, false],
    ["blurred", true, false, "env:thread", 4, 4, false],
    ["route switched", true, true, "env:other", 4, 4, false],
    ["route revisited", true, true, "env:thread", 5, 4, false],
    ["same focused owner", true, true, "env:thread", 4, 4, true],
  ] as const)(
    "only completes for a live %s owner",
    (_name, mounted, focused, currentOwnerKey, currentGeneration, requestGeneration, allowed) => {
      expect(
        canCompleteSideQuestion({
          mounted,
          focused,
          currentOwnerKey,
          ownerKey: "env:thread",
          currentGeneration,
          requestGeneration,
        }),
      ).toBe(allowed);
    },
  );

  it("shows native origin provenance without copying source history", () => {
    expect(
      formatSidechatOrigin({
        threadId: ThreadId.make("main"),
        turnId: TurnId.make("turn-7"),
        createdAt: "2026-09-19T00:00:00.000Z",
      }),
    ).toBe("From source turn turn-7");
  });
});
