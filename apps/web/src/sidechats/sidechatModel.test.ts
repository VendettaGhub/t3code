import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, TurnId, type EnvironmentId, type ProviderDriverKind } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  describeSidechatOrigin,
  orderSidechats,
  resolveSidechatDetailState,
  resolveSidechatLaunchState,
  resolveSidechatWorkspaceNotice,
  resolveSidechatSourceThreadRef,
  sidechatThreadRef,
  sidechatsForSource,
  UNAVAILABLE_SIDECHAT_ADAPTER,
  type Sidechat,
  type SidechatAdapter,
} from "./sidechatModel";

const environmentId = "env-1" as EnvironmentId;
const provider = "claude" as ProviderDriverKind;
const sourceThreadRef = scopeThreadRef(environmentId, ThreadId.make("main"));

const origin = {
  threadId: ThreadId.make("main"),
  turnId: TurnId.make("turn-7"),
  createdAt: "2026-09-01T00:00:00.000Z",
} as const;

const sidechat = (overrides: Partial<Sidechat> = {}): Sidechat => ({
  id: "sc-1",
  title: "Alternative approach",
  origin,
  targetThreadId: ThreadId.make("thread-sc-1"),
  status: "ready",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

const readyAdapter = (sidechats: ReadonlyArray<Sidechat> = [sidechat()]): SidechatAdapter => ({
  list: { kind: "ready", sidechats },
  supportedProviders: new Set([provider]),
  fork: async () => ({ targetThreadId: ThreadId.make("thread-sc-1"), origin }),
});

describe("sidechat source thread", () => {
  it("uses the main thread origin when launching from a child", () => {
    const child = scopeThreadRef(environmentId, ThreadId.make("child"));
    expect(resolveSidechatSourceThreadRef(child, origin)).toEqual(sourceThreadRef);
  });

  it("keeps a main thread as its own source", () => {
    expect(resolveSidechatSourceThreadRef(sourceThreadRef, null)).toEqual(sourceThreadRef);
  });
});

describe("sidechat launch state", () => {
  const base = {
    adapter: readyAdapter(),
    provider,
    sourceThreadRef,
    sourceTurn: { turnId: "turn-7", completed: true },
    mainThreadBusy: false,
  };

  it("is ready only when backend, provider, thread and a completed idle turn all line up", () => {
    expect(resolveSidechatLaunchState(base)).toEqual({ kind: "ready" });
  });

  it("refuses rather than falling back when the backend is missing", () => {
    // The default adapter is what ships until the server slice lands; it must
    // block the launcher instead of opening onto an empty surface.
    const state = resolveSidechatLaunchState({
      ...base,
      adapter: UNAVAILABLE_SIDECHAT_ADAPTER,
    });
    expect(state).toMatchObject({ kind: "blocked", reason: "backend-unavailable" });
  });

  it("treats an adapter that cannot name its providers as unsupported", () => {
    // Guessing a provider list here is the silent fallback this surface bans.
    const state = resolveSidechatLaunchState({
      ...base,
      adapter: { ...readyAdapter(), supportedProviders: null },
    });
    expect(state).toMatchObject({ kind: "blocked", reason: "provider-unsupported" });
    expect(
      resolveSidechatLaunchState({ ...base, provider: "other" as ProviderDriverKind }),
    ).toMatchObject({ reason: "provider-unsupported" });
  });

  it("blocks on a busy main thread ahead of an incomplete turn", () => {
    // While the thread works, "wait for the turn" is the actionable message;
    // the turn being incomplete is a consequence, not the cause.
    expect(
      resolveSidechatLaunchState({
        ...base,
        mainThreadBusy: true,
        sourceTurn: { turnId: "turn-7", completed: false },
      }),
    ).toMatchObject({ reason: "source-busy" });
  });

  it("blocks a missing or unfinished source turn", () => {
    expect(resolveSidechatLaunchState({ ...base, sourceTurn: null })).toMatchObject({
      reason: "source-incomplete",
    });
    expect(
      resolveSidechatLaunchState({ ...base, sourceTurn: { turnId: "turn-7", completed: false } }),
    ).toMatchObject({ reason: "source-incomplete" });
  });

  it("blocks when there is no saved thread to fork from", () => {
    expect(resolveSidechatLaunchState({ ...base, sourceThreadRef: null })).toMatchObject({
      reason: "no-source-thread",
    });
  });
});

describe("native sidechat projection", () => {
  it("keeps only forked threads from the active environment", () => {
    const otherOrigin = { ...origin, threadId: ThreadId.make("other") };
    expect(
      sidechatsForSource(
        [
          {
            environmentId,
            id: ThreadId.make("thread-sc-1"),
            title: "Sidechat: Alternative approach",
            origin,
            updatedAt: "2026-09-02T00:00:00.000Z",
          },
          {
            environmentId: "env-2" as EnvironmentId,
            id: ThreadId.make("thread-sc-2"),
            title: "Wrong environment",
            origin,
            updatedAt: "2026-09-03T00:00:00.000Z",
          },
          {
            environmentId,
            id: ThreadId.make("thread-other"),
            title: "Other source",
            origin: otherOrigin,
            updatedAt: "2026-09-04T00:00:00.000Z",
          },
        ],
        sourceThreadRef,
      ),
    ).toMatchObject([{ id: "thread-sc-1", status: "ready" }]);
  });
});

describe("sidechat detail state", () => {
  const base = {
    environmentId,
    sidechats: [sidechat()],
    canRenderThread: true,
  };

  it("shows the index when nothing is selected", () => {
    expect(resolveSidechatDetailState({ ...base, selectedSidechatId: null })).toEqual({
      kind: "index",
    });
  });

  it("addresses a resolved fork as a normal thread reference", () => {
    const state = resolveSidechatDetailState({ ...base, selectedSidechatId: "sc-1" });
    expect(state).toMatchObject({ kind: "thread" });
    expect(state.kind === "thread" && state.threadRef.threadId).toBe("thread-sc-1");
  });

  it("reports a stale selection instead of bouncing back to the index", () => {
    expect(
      resolveSidechatDetailState({ ...base, sidechats: [], selectedSidechatId: "sc-1" }),
    ).toMatchObject({ kind: "unavailable", reason: "stale-selection" });
  });

  it("refuses to render a transcript before the fork is addressable", () => {
    expect(
      resolveSidechatDetailState({
        ...base,
        sidechats: [sidechat({ targetThreadId: null, status: "pending" })],
        selectedSidechatId: "sc-1",
      }),
    ).toMatchObject({ reason: "no-target-thread" });
  });

  it("surfaces a failed fork as its own state", () => {
    expect(
      resolveSidechatDetailState({
        ...base,
        sidechats: [sidechat({ status: "failed" })],
        selectedSidechatId: "sc-1",
      }),
    ).toMatchObject({ reason: "failed" });
  });

  it("says so when the host supplied no thread renderer", () => {
    // Mounting a second ChatView is the host's call; without one the panel
    // must not improvise a transcript of its own.
    expect(
      resolveSidechatDetailState({ ...base, canRenderThread: false, selectedSidechatId: "sc-1" }),
    ).toMatchObject({ reason: "no-thread-host" });
  });
});

describe("sidechatThreadRef", () => {
  it("returns null until there is a real target thread and environment", () => {
    expect(sidechatThreadRef(environmentId, null)).toBeNull();
    expect(sidechatThreadRef(environmentId, "   ")).toBeNull();
    expect(sidechatThreadRef(null, "thread-1")).toBeNull();
    expect(sidechatThreadRef(environmentId, "thread-1")).toMatchObject({
      environmentId,
      threadId: "thread-1",
    });
  });
});

describe("shared workspace notice", () => {
  it("stays silent on an isolated worktree", () => {
    expect(
      resolveSidechatWorkspaceNotice({ workspaceShared: false, mainThreadBusy: true }).level,
    ).toBe("none");
  });

  it("is quiet while idle and escalates only while the main thread works", () => {
    const idle = resolveSidechatWorkspaceNotice({ workspaceShared: true, mainThreadBusy: false });
    expect(idle.level).toBe("info");
    expect(idle.message).toContain("Files are shared");
    expect(idle.message).toContain("File restore may be unavailable");
    const busy = resolveSidechatWorkspaceNotice({ workspaceShared: true, mainThreadBusy: true });
    expect(busy.level).toBe("warning");
    expect(busy.message).toContain("same worktree");
    expect(busy.message).toContain("Files are shared");
  });
});

describe("orderSidechats", () => {
  it("puts recent activity first and breaks ties stably", () => {
    const older = sidechat({ id: "a", updatedAt: "2026-09-01T00:00:00.000Z" });
    const newer = sidechat({ id: "b", updatedAt: "2026-09-03T00:00:00.000Z" });
    const tie = sidechat({ id: "c", updatedAt: "2026-09-03T00:00:00.000Z" });
    expect(orderSidechats([older, tie, newer]).map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });
});

describe("describeSidechatOrigin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads as a plain sentence and keeps the exact turn id in the detail", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T02:30:00.000Z"));
    const described = describeSidechatOrigin(origin);
    expect(described.label).toBe("Forked from the main thread 2h ago");
    expect(described.label).not.toContain(origin.turnId);
    expect(described.detail).toBe("Origin turn turn-7");
  });

  it("drops the time rather than inventing one when the origin timestamp is unreadable", () => {
    const described = describeSidechatOrigin({ ...origin, createdAt: "not-a-date" });
    expect(described.label).toBe("Forked from the main thread");
    expect(described.detail).toContain("turn-7");
  });
});
