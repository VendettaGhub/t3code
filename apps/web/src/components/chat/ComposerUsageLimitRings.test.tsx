import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectComposerRingColumns,
  collectComposerUsageLimitRings,
  compactHintDescription,
  formatRingReset,
  hasComposerUsageLimitChrome,
  ringAriaLabel,
  usageRingColor,
} from "./ComposerUsageLimitRings";
import type { ComposerUsageLimitRing } from "./ComposerUsageLimitRings";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { shouldUseRestingComposerLayout } from "../composerFooterLayout";

const environmentId = EnvironmentId.make("composer-rings-test");
const otherEnvironmentId = EnvironmentId.make("other-environment");
const now = Date.parse("2026-09-09T12:00:00.000Z");

type Window = {
  id: string;
  kind: "session" | "weekly" | "monthly" | "other";
  label: string;
  usedPercent: number;
  resetsAt?: string;
};

function provider(
  instanceId: string,
  usedPercent: number,
  driver = ProviderDriverKind.make("codex"),
  options: { email?: string; checkedAt?: number; windows?: readonly Window[] } = {},
): ServerProvider {
  const checkedAt = new Date(options.checkedAt ?? now).toISOString();
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: options.email ?? `${instanceId}@example.com` },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: options.windows ?? [
        { id: "five-hour", kind: "session", label: "Session", usedPercent },
      ],
    },
  };
}

function presentations(
  entries: ReadonlyArray<readonly [EnvironmentId, readonly ServerProvider[]]>,
) {
  const map = new Map<
    EnvironmentId,
    {
      entry: { target: { label: string } };
      serverConfig: { providers: readonly ServerProvider[] };
    }
  >();
  for (const [id, providers] of entries) {
    map.set(id, { entry: { target: { label: String(id) } }, serverConfig: { providers } });
  }
  return map as Parameters<typeof collectComposerUsageLimitRings>[0];
}

describe("ComposerUsageLimitRings", () => {
  it("preserves same-id windows of different kinds without a ring identity collision", () => {
    const rings = collectComposerUsageLimitRings(
      presentations([
        [
          environmentId,
          [
            provider("native", 20, ProviderDriverKind.make("codex"), {
              windows: [
                { id: "shared", kind: "session", label: "Session", usedPercent: 20 },
                { id: "shared", kind: "weekly", label: "Weekly", usedPercent: 70 },
              ],
            }),
          ],
        ],
      ]),
      now,
    );
    expect(
      rings.map(({ driver, kind, id, usedPercent }) => [driver, kind, id, usedPercent]),
    ).toEqual([
      ["codex", "session", "shared", 20],
      ["codex", "weekly", "shared", 70],
    ]);
  });
  it("leaves an empty or loading composer resting but keeps quota or context visible", () => {
    const empty = collectComposerUsageLimitRings(new Map(), now);
    const loading = collectComposerUsageLimitRings(
      new Map([[environmentId, { entry: { target: { label: "Loading" } }, serverConfig: null }]]),
      now,
    );
    expect(empty).toEqual([]);
    expect(loading).toEqual([]);
    const resting = (
      rings: readonly ComposerUsageLimitRing[],
      contextHint?: ComposerBannerStackItem,
    ) =>
      shouldUseRestingComposerLayout({
        isExistingThread: true,
        isMobileViewport: false,
        isScrollCollapsed: true,
        timelineOverflows: true,
        hasMultilinePrompt: false,
        hasExpandedChrome: hasComposerUsageLimitChrome(rings, contextHint),
      });
    expect(resting(empty)).toBe(true);
    expect(resting(loading)).toBe(true);
    expect(
      resting(empty, {
        id: "resume-compaction:thread",
        title: "Context",
        icon: null,
        variant: "info",
      }),
    ).toBe(false);
    expect(
      resting(
        collectComposerUsageLimitRings(
          presentations([[environmentId, [provider("native", 20)]]]),
          now,
        ),
      ),
    ).toBe(false);
  });

  it("includes native usage sources and deduplicates their account against a provider", () => {
    const native = provider("native", 30, ProviderDriverKind.make("codex"), {
      email: "same@example.com",
    });
    const source = {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy" as const,
      label: "Hub",
      checkedAt: new Date(now).toISOString(),
      accounts: [
        {
          id: "same",
          driver: native.driver,
          email: "same@example.com",
          usageLimits: native.usageLimits!,
        },
        {
          id: "other",
          driver: native.driver,
          email: "other@example.com",
          usageLimits: {
            checkedAt: new Date(now).toISOString(),
            windows: [
              { id: "five-hour", kind: "session" as const, label: "Session", usedPercent: 70 },
            ],
          },
        },
      ],
    };
    const rings = collectComposerUsageLimitRings(
      new Map([
        [
          environmentId,
          {
            entry: { target: { label: "Local" } },
            serverConfig: { providers: [native], usageLimitSources: [source] },
          },
        ],
      ]),
      now,
    );
    expect(rings).toHaveLength(1);
    expect(rings[0]).toMatchObject({ usedPercent: 50, remainingPercent: 50 });
  });
  it("shortens the resume token hint while preserving other content", () => {
    expect(compactHintDescription("117k tokens from earlier")).toBe("117k");
    expect(compactHintDescription("1.2M tokens from earlier")).toBe("1.2M");
    expect(compactHintDescription("Other context hint")).toBe("Other context hint");
    expect(compactHintDescription(117000)).toBe(117000);
    expect(compactHintDescription(undefined)).toBeUndefined();
  });
  it("treats rings and context-only hints as expanded composer chrome", () => {
    expect(hasComposerUsageLimitChrome([], undefined)).toBe(false);
    expect(hasComposerUsageLimitChrome([{} as ComposerUsageLimitRing], undefined)).toBe(true);
    expect(hasComposerUsageLimitChrome([], {} as ComposerBannerStackItem)).toBe(true);
  });

  it("formats real reset distance without inventing a fresh window after expiry", () => {
    expect(formatRingReset(null, now)).toBe("?");
    expect(formatRingReset(Number.NaN, now)).toBe("?");
    expect(formatRingReset(now - 1, now)).toBe("due");
    expect(formatRingReset(now, now)).toBe("due");
    expect(formatRingReset(now + 30 * 60_000, now)).toBe("30m");
    expect(formatRingReset(now + 3 * 3_600_000, now)).toBe("3h");
    expect(formatRingReset(now + 2 * 86_400_000, now)).toBe("2d");
    expect(formatRingReset(now + 2 * 3_600_000 + 60_000, now)).toBe("2h");
    expect(formatRingReset(now + 4 * 86_400_000 + 3_600_000, now)).toBe("4d");
    expect(formatRingReset(now + 1, now)).toBe("1m");
    expect(formatRingReset(now + 59 * 60_000, now)).toBe("59m");
    expect(formatRingReset(now + 60 * 60_000, now)).toBe("1h");
    expect(formatRingReset(now + 24 * 3_600_000, now)).toBe("1d");
    expect(formatRingReset(now + 3_600_000 - 1, now)).toBe("60m");
    expect(formatRingReset(now + 86_400_000 - 1, now)).toBe("23h");
  });

  it("uses the mobile quota color ramp and clamps out-of-range usage", () => {
    expect([0, 50, 100].map(usageRingColor)).toEqual(["#22c55e", "#f59e0b", "#ef4444"]);
    expect([usageRingColor(-10), usageRingColor(140)]).toEqual(["#22c55e", "#ef4444"]);
  });

  it("counts down on minute ticks while quota remains the provider's last reported value", () => {
    const at = now + 30 * 60_000;
    const source = presentations([
      [
        environmentId,
        [
          provider("test", 80, ProviderDriverKind.make("codex"), {
            windows: [
              {
                id: "session",
                kind: "session",
                label: "Session",
                usedPercent: 80,
                resetsAt: new Date(at).toISOString(),
              },
            ],
          }),
        ],
      ],
    ]);
    expect(
      [now, now + 60_000, now + 2 * 60_000].map((tick) => {
        const ring = collectComposerUsageLimitRings(source, tick)[0]!;
        return formatRingReset(ring.resetsAt, tick);
      }),
    ).toEqual(["30m", "29m", "28m"]);
    const ring = collectComposerUsageLimitRings(source, at + 60_000)[0]!;
    expect(ring.usedPercent).toBe(80);
    expect(formatRingReset(ring.resetsAt, at + 60_000)).toBe("due");
    expect(ringAriaLabel(ring, now)).toContain(new Date(at).toISOString());
    expect(ringAriaLabel(ring, at + 60_000)).toContain("awaiting refreshed limits");
  });

  it("keeps pooled used endpoints and the next reported reset without projecting renewed quota", () => {
    const rings = collectComposerUsageLimitRings(
      presentations([
        [
          environmentId,
          [
            provider("test", 0, ProviderDriverKind.make("codex"), {
              windows: [
                {
                  id: "empty",
                  kind: "session",
                  label: "Empty",
                  usedPercent: 0,
                  resetsAt: new Date(now + 60_000).toISOString(),
                },
                {
                  id: "spent",
                  kind: "weekly",
                  label: "Spent",
                  usedPercent: 100,
                  resetsAt: new Date(now - 60_000).toISOString(),
                },
                { id: "unknown", kind: "other", label: "Unknown", usedPercent: 50 },
              ],
            }),
          ],
        ],
      ]),
      now,
    );
    expect(rings.map(({ usedPercent, resetsAt }) => ({ usedPercent, resetsAt }))).toEqual([
      { usedPercent: 0, resetsAt: now + 60_000 },
      { usedPercent: 100, resetsAt: now - 60_000 },
      { usedPercent: 50, resetsAt: null },
    ]);
  });

  it("uses the earliest account reset in a pooled window", () => {
    const rings = collectComposerUsageLimitRings(
      presentations([
        [
          environmentId,
          [
            provider("later", 20, ProviderDriverKind.make("codex"), {
              windows: [
                {
                  id: "session",
                  kind: "session",
                  label: "Session",
                  usedPercent: 20,
                  resetsAt: new Date(now + 3_600_000).toISOString(),
                },
              ],
            }),
            provider("sooner", 80, ProviderDriverKind.make("codex"), {
              windows: [
                {
                  id: "session",
                  kind: "session",
                  label: "Session",
                  usedPercent: 80,
                  resetsAt: new Date(now + 60_000).toISOString(),
                },
              ],
            }),
          ],
        ],
      ]),
      now,
    );
    expect(rings[0]).toMatchObject({ usedPercent: 50, resetsAt: now + 60_000 });
  });
  it("pools accounts across environments and keeps one canonical fresh account", () => {
    const rings = collectComposerUsageLimitRings(
      presentations([
        [
          environmentId,
          [
            provider("old", 20, ProviderDriverKind.make("codex"), {
              email: "same@example.com",
              checkedAt: now - 60_000,
            }),
          ],
        ],
        [
          otherEnvironmentId,
          [
            provider("fresh", 80, ProviderDriverKind.make("codex"), {
              email: "same@example.com",
              checkedAt: now,
            }),
          ],
        ],
      ]),
      now,
    );

    expect(rings).toMatchObject([
      {
        driver: "codex",
        driverLabel: "Codex",
        id: "five-hour",
        usedPercent: 80,
        remainingPercent: 20,
      },
    ]);
  });

  it("keeps distinct drivers separate even when their window ids match", () => {
    const rings = collectComposerUsageLimitRings(
      presentations([
        [
          environmentId,
          [
            provider("codex", 20, ProviderDriverKind.make("codex")),
            provider("claude", 60, ProviderDriverKind.make("claude")),
          ],
        ],
      ]),
      now,
    );

    expect(rings).toMatchObject([
      { driver: "codex", driverLabel: "Codex", windowLabel: "Session", remainingPercent: 80 },
      {
        driver: "claude",
        driverLabel: "claude",
        windowLabel: "Session",
        remainingPercent: 40,
      },
    ]);
  });

  it("preserves four windows and provider-specific labels such as Fable", () => {
    const rings = collectComposerUsageLimitRings(
      presentations([
        [
          environmentId,
          [
            provider("claude", 25, ProviderDriverKind.make("claude"), {
              windows: [
                { id: "session", kind: "session", label: "Session", usedPercent: 25 },
                { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 50 },
                { id: "weekly-fable", kind: "weekly", label: "Weekly Fable", usedPercent: 75 },
                { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 10 },
              ],
            }),
          ],
        ],
      ]),
      now,
    );

    expect(rings).toHaveLength(4);
    expect(rings.map((ring) => ring.shortLabel)).toEqual(["S", "W", "F", "Monthly"]);
    expect(rings.map((ring) => `${ring.driverLabel} ${ring.windowLabel}`)).toEqual([
      "claude Session",
      "claude Weekly",
      "claude Weekly Fable",
      "claude Monthly",
    ]);
  });

  it("lays Claude out left of Codex without dropping or reordering rings", () => {
    const rings = collectComposerUsageLimitRings(
      presentations([
        [
          environmentId,
          [
            provider("codex", 20, ProviderDriverKind.make("codex")),
            provider("claude", 60, ProviderDriverKind.make("claude"), {
              windows: [
                { id: "session", kind: "session", label: "Session", usedPercent: 25 },
                { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 50 },
              ],
            }),
          ],
        ],
      ]),
      now,
    );
    const columns = collectComposerRingColumns(rings);

    expect(
      columns.map((column) =>
        column.map((group) => [group.driver, group.rings.map((ring) => ring.shortLabel)]),
      ),
    ).toEqual([[["claude", ["S", "W"]]], [["codex", ["S"]]]]);
    expect(columns.flatMap((column) => column.flatMap((group) => group.rings))).toHaveLength(
      rings.length,
    );
  });

  it("gives a lone provider the whole bar instead of an empty half", () => {
    const columns = collectComposerRingColumns(
      collectComposerUsageLimitRings(
        presentations([[environmentId, [provider("codex", 20, ProviderDriverKind.make("codex"))]]]),
        now,
      ),
    );

    expect(columns).toHaveLength(1);
    expect(columns[0]?.[0]?.driver).toBe("codex");
  });

  it("omits unavailable accounts through the canonical account collector", () => {
    const rings = collectComposerUsageLimitRings(
      presentations([
        [
          environmentId,
          [
            {
              ...provider("unsupported", 20),
              usageLimits: {
                checkedAt: new Date(now).toISOString(),
                windows: [],
                unavailable: { reason: "unsupported" },
              },
            },
          ],
        ],
      ]),
      now,
    );

    expect(rings).toEqual([]);
  });
});
