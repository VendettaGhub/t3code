import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectComposerUsageLimits,
  collectComposerUsageRings,
  formatResetCountdown,
  groupComposerUsageRings,
  usageRingColor,
} from "./ComposerUsageLimits.logic";

const now = Date.parse("2026-09-09T12:00:00.000Z");
const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");

function provider(
  instanceId: string,
  driver: "codex" | "claudeAgent",
  windows: ReadonlyArray<{
    readonly id: string;
    readonly kind: "session" | "weekly" | "monthly" | "other";
    readonly label: string;
    readonly usedPercent: number;
    readonly resetsAt?: string;
  }>,
  checkedAt = now,
): ServerProvider {
  const checked = new Date(checkedAt).toISOString();
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: `${instanceId}@example.com` },
    checkedAt: checked,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: checked, windows },
  } as ServerProvider;
}

function presentations(
  entries: ReadonlyArray<readonly [EnvironmentId, readonly ServerProvider[]]>,
) {
  return new Map(
    entries.map(([environmentId, providers]) => [
      environmentId,
      {
        entry: { target: { label: String(environmentId) } },
        serverConfig: { providers },
      },
    ]),
  ) as Parameters<typeof collectComposerUsageRings>[0];
}

describe("collectComposerUsageRings", () => {
  it("ramps the arc from green when untouched to red when spent", () => {
    expect([0, 50, 100].map(usageRingColor)).toEqual(["#22c55e", "#f59e0b", "#ef4444"]);
    // Out-of-range readings clamp rather than producing an unparsable colour.
    expect([usageRingColor(-10), usageRingColor(140)]).toEqual(["#22c55e", "#ef4444"]);
    expect(usageRingColor(25)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("uses consumed percentage for empty and full rings", () => {
    const rings = collectComposerUsageRings(
      presentations([
        [
          environmentA,
          [
            provider("codex", "codex", [
              { id: "session", kind: "session", label: "Session", usedPercent: 0 },
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 },
            ]),
          ],
        ],
      ]),
      now,
    );

    expect(rings.map((ring) => [ring.shortLabel, ring.usedPercent])).toEqual([
      ["S", 0],
      ["W", 100],
    ]);
  });

  it("keeps Claude's scoped Fable window and reset timestamp without inventing missing windows", () => {
    const rings = collectComposerUsageRings(
      presentations([
        [
          environmentA,
          [
            provider("claude", "claudeAgent", [
              { id: "session", kind: "session", label: "Session", usedPercent: 45 },
              {
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 12,
                resetsAt: "2026-09-10T12:00:00.000Z",
              },
              {
                id: "weekly-fable",
                kind: "weekly",
                label: "Weekly · Fable",
                usedPercent: 88,
              },
            ]),
          ],
        ],
      ]),
      now,
    );

    expect(rings.map((ring) => ring.shortLabel)).toEqual(["S", "W", "F"]);
    expect(rings[1]?.resetsAt).toBe("2026-09-10T12:00:00.000Z");
  });

  it("pools all environments and keeps the freshest account snapshot", () => {
    const rings = collectComposerUsageRings(
      presentations([
        [
          environmentA,
          [
            provider(
              "codex",
              "codex",
              [{ id: "session", kind: "session", label: "Session", usedPercent: 20 }],
              now - 60_000,
            ),
          ],
        ],
        [
          environmentB,
          [
            provider(
              "codex",
              "codex",
              [{ id: "session", kind: "session", label: "Session", usedPercent: 80 }],
              now,
            ),
          ],
        ],
      ]),
      now,
    );

    expect(rings).toMatchObject([{ driver: "codex", usedPercent: 80 }]);
  });

  it("uses the pooled consumed share for distinct accounts, matching Usage → Limits", () => {
    const rings = collectComposerUsageRings(
      presentations([
        [
          environmentA,
          [
            provider("zero", "codex", [
              { id: "session", kind: "session", label: "Session", usedPercent: 0 },
            ]),
            provider("full", "codex", [
              { id: "session", kind: "session", label: "Session", usedPercent: 100 },
            ]),
          ],
        ],
      ]),
      now,
    );

    expect(rings).toMatchObject([{ shortLabel: "S", usedPercent: 50 }]);
  });

  it("uses the earliest pooled reset when account ordering differs by window", () => {
    const input = presentations([
      [
        environmentA,
        [
          provider("later-weekly", "codex", [
            {
              id: "session",
              kind: "session",
              label: "Session",
              usedPercent: 20,
              resetsAt: "2026-09-09T13:00:00.000Z",
            },
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 20,
              resetsAt: "2026-09-11T12:00:00.000Z",
            },
          ]),
          provider("earlier-weekly", "codex", [
            {
              id: "session",
              kind: "session",
              label: "Session",
              usedPercent: 40,
              resetsAt: "2026-09-09T18:00:00.000Z",
            },
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 40,
              resetsAt: "2026-09-10T12:00:00.000Z",
            },
          ]),
        ],
      ],
    ]);
    const rings = collectComposerUsageRings(input, now);

    expect(rings.find((ring) => ring.kind === "weekly")?.resetsAt).toBe("2026-09-10T12:00:00.000Z");
  });
});

describe("formatResetCountdown", () => {
  it("reduces the reset to one token the ring can hold", () => {
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(formatResetCountdown(at(4 * 24 * 3_600_000), now)).toBe("4d");
    expect(formatResetCountdown(at(2 * 3_600_000 + 13 * 60_000), now)).toBe("2h");
    expect(formatResetCountdown(at(35 * 60_000), now)).toBe("35m");
    expect(formatResetCountdown(at(10_000), now)).toBe("1m");
    expect(formatResetCountdown(at(-60_000), now)).toBe("now");
  });

  it("has nothing to show for a window without a reset", () => {
    expect(formatResetCountdown(undefined, now)).toBeNull();
    expect(formatResetCountdown("not a date", now)).toBeNull();
  });
});

describe("groupComposerUsageRings", () => {
  it("puts Claude left and Codex right, keeping every other driver", () => {
    const rings = collectComposerUsageRings(
      presentations([
        [
          environmentA,
          [
            provider("codex", "codex", [
              { id: "session", kind: "session", label: "Session", usedPercent: 10 },
            ]),
            provider("claude", "claudeAgent", [
              { id: "session", kind: "session", label: "Session", usedPercent: 20 },
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 30 },
            ]),
          ],
        ],
      ]),
      now,
    );

    expect(
      groupComposerUsageRings(rings).map((group) => [group.driver, group.rings.length]),
    ).toEqual([
      ["claudeAgent", 2],
      ["codex", 1],
    ]);
  });
});

describe("collectComposerUsageLimits", () => {
  it("returns null when no pooled limits or notices exist", () => {
    const report = collectComposerUsageLimits(presentations([]), now);
    expect(report).toBeNull();
  });
});
