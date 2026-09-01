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

describe("groupProviderLimits", () => {
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
});
