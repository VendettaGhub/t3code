import { EnvironmentId, type ProviderLimitsSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupProviderLimits,
  type ProviderLimitsEnvironmentState,
} from "./ProviderLimitsPanel.logic";

const snapshot = (provider: "claude" | "codex", capturedAt: number): ProviderLimitsSnapshot => ({
  provider,
  capturedAt,
  source: "read",
  authState: "ok",
  parseWarnings: [],
  buckets: [
    {
      bucketId: `${provider}-weekly`,
      displayName: "Weekly",
      kind: "weekly",
      primary: { label: "Week", usedPercent: capturedAt },
    },
  ],
});

function environment(
  id: string,
  accountId: string | undefined,
  capturedAt: number,
): ProviderLimitsEnvironmentState {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    data: { codex: snapshot("codex", capturedAt) },
    error: null,
    isPending: false,
    accountIds: accountId === undefined ? {} : { codex: accountId },
  };
}

function unavailableEnvironment(
  id: string,
  accountId: string | undefined,
  capturedAt: number,
): ProviderLimitsEnvironmentState {
  const base = environment(id, accountId, capturedAt);
  return {
    ...base,
    data: {
      codex: {
        ...base.data!.codex!,
        buckets: [],
        authState: "unavailable",
        parseWarnings: ["Usage is unavailable."],
      },
    },
  };
}

describe("groupProviderLimits", () => {
  it("reports failed empty snapshots instead of silently dropping authentication errors", () => {
    const failed = environment("windows", undefined, 10);
    const grouped = groupProviderLimits([
      {
        ...failed,
        data: {
          codex: {
            ...snapshot("codex", 10),
            buckets: [],
            authState: "unauthenticated",
            parseWarnings: ["Sign in again."],
          },
        },
      },
    ]);
    expect(grouped.accounts).toHaveLength(0);
    expect(grouped.errors).toEqual(["windows · Codex: Sign in again."]);
  });

  it("shows one newest quota for environments using the same OAuth account", () => {
    const grouped = groupProviderLimits([
      environment("windows", "User@Example.com", 10),
      environment("wsl", "user@example.com", 20),
    ]);

    expect(grouped.accounts).toHaveLength(1);
    expect(grouped.accounts[0]?.snapshot.capturedAt).toBe(20);
    expect(grouped.accounts[0]?.environmentIds).toHaveLength(2);
  });

  it("keeps different accounts separate", () => {
    const grouped = groupProviderLimits([
      environment("work", "work@example.com", 10),
      environment("personal", "personal@example.com", 20),
    ]);

    expect(grouped.accounts).toHaveLength(2);
  });

  it("does not guess account identity when OAuth metadata is unavailable", () => {
    const grouped = groupProviderLimits([
      environment("windows", undefined, 10),
      environment("wsl", undefined, 20),
    ]);

    expect(grouped.accounts).toHaveLength(2);
  });

  it("hides stale quota when a newer same-account snapshot is unavailable", () => {
    const grouped = groupProviderLimits([
      unavailableEnvironment("wsl", "user@example.com", 20),
      environment("windows", "USER@example.com", 10),
    ]);

    expect(grouped.accounts).toHaveLength(0);
    expect(grouped.errors).toContain("wsl · Codex: Usage is unavailable.");
  });

  it.each([false, true])(
    "unavailable wins timestamp ties regardless of order (reverse=%s)",
    (reverse) => {
      const inputs = [
        environment("windows", "user@example.com", 20),
        unavailableEnvironment("wsl", "user@example.com", 20),
      ];
      const grouped = groupProviderLimits(reverse ? inputs.toReversed() : inputs);
      expect(grouped.accounts).toHaveLength(0);
      expect(grouped.errors).toContain("wsl · Codex: Usage is unavailable.");
    },
  );

  it("keeps an independent account when another account becomes unavailable", () => {
    const grouped = groupProviderLimits([
      environment("windows", "work@example.com", 10),
      unavailableEnvironment("wsl", "personal@example.com", 20),
    ]);

    expect(grouped.accounts).toHaveLength(1);
    expect(grouped.accounts[0]?.accountId).toBe("work@example.com");
  });

  it("does not let an unavailable unknown account suppress a known account", () => {
    const grouped = groupProviderLimits([
      environment("windows", "work@example.com", 10),
      unavailableEnvironment("wsl", undefined, 20),
    ]);

    expect(grouped.accounts).toHaveLength(1);
    expect(grouped.accounts[0]?.accountId).toBe("work@example.com");
  });

  it("keeps an older unknown-account quota when the newer snapshot is unauthenticated", () => {
    const unavailable = unavailableEnvironment("windows", undefined, 20);
    const grouped = groupProviderLimits([
      environment("windows", undefined, 10),
      {
        ...unavailable,
        data: {
          codex: {
            ...unavailable.data!.codex!,
            authState: "unauthenticated",
          },
        },
      },
    ]);

    expect(grouped.accounts).toHaveLength(1);
    expect(grouped.accounts[0]?.accountId).toBeNull();
  });
});
