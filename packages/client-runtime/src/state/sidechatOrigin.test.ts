import { EnvironmentId, RunId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { presentThreadShell, sidechatOriginPoint, supportsNativeSidechat } from "./models.ts";
import { v2ThreadShell, v2Projection } from "./orchestrationV2TestFixtures.ts";

describe("V2 sidechat origin presentation", () => {
  it("never advertises imported UI history without native provider execution as forkable", () => {
    expect(supportsNativeSidechat(null)).toBe(false);
    expect(
      supportsNativeSidechat({
        ...v2Projection,
        thread: { ...v2Projection.thread, historyOrigin: "v1_import" },
      }),
    ).toBe(false);
  });
  it("keeps native run IDs distinct from legacy turn IDs and ignores regular forks", () => {
    const environmentId = EnvironmentId.make("test");
    const forkedFrom = {
      type: "run" as const,
      threadId: ThreadId.make("source"),
      runId: RunId.make("run"),
    };
    expect(presentThreadShell(environmentId, { ...v2ThreadShell, forkedFrom }).origin).toBeNull();
    const native = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      sidechat: true,
      forkedFrom,
    }).origin;
    expect(native).toEqual({
      threadId: "source",
      runId: "run",
      createdAt: "2026-06-20T00:00:00.000Z",
    });
    expect(native && sidechatOriginPoint(native)).toBe("run");
    const origin = {
      threadId: ThreadId.make("legacy-source"),
      turnId: TurnId.make("legacy-turn"),
      createdAt: "2026-05-01T00:00:00.000Z",
    };
    expect(presentThreadShell(environmentId, { ...v2ThreadShell, origin }).origin).toEqual(origin);
    expect(sidechatOriginPoint(origin)).toBe("legacy-turn");
    expect(
      presentThreadShell(environmentId, { ...v2ThreadShell, sidechat: true }).origin,
    ).toBeNull();
  });
});
