import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { pooledAccountsSummary, providerColumns } from "./UsageLimitsPooled";

function account(overrides: Partial<LimitAccount> = {}): LimitAccount {
  return {
    key: "key",
    driver: ProviderDriverKind.make("claude"),
    displayName: null,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: undefined,
    limits: { checkedAt: new Date(0).toISOString(), windows: [] },
    ...overrides,
  } as LimitAccount;
}

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

describe("providerColumns", () => {
  const of = (groups: readonly string[]) => providerColumns(groups, (group) => group);

  it("puts Claude left and Codex right whatever order they arrive in", () => {
    expect(of(["codex", "claude"])).toEqual([["claude"], ["codex"]]);
    expect(of(["claude", "codex"])).toEqual([["claude"], ["codex"]]);
    expect(of(["cursor", "claudeAgent", "codex"])).toEqual([["cursor", "claudeAgent"], ["codex"]]);
  });

  it("gives an unknown driver the shorter column instead of dropping it", () => {
    expect(of(["claude", "codex", "cursor"])).toEqual([["claude", "cursor"], ["codex"]]);
    expect(of(["claude", "cursor"])).toEqual([["claude"], ["cursor"]]);
    expect(of(["cursor", "grok", "opencode"])).toEqual([["cursor", "opencode"], ["grok"]]);
  });

  it("hands a single column to a lone provider and nothing to none", () => {
    expect(of(["claude"])).toEqual([["claude"]]);
    expect(of(["codex"])).toEqual([["codex"]]);
    expect(of([])).toEqual([]);
  });
});

describe("pooledAccountsSummary", () => {
  it("names the single account and its plan, the way the composer header reads", () => {
    expect(
      pooledAccountsSummary([account({ displayName: "Claude", plan: "Claude Team Subscription" })]),
    ).toBe("Claude · Claude Team Subscription");
    expect(pooledAccountsSummary([account({ displayName: "Claude" })])).toBe("Claude");
  });

  it("falls back to the driver label when the account has no display name", () => {
    expect(pooledAccountsSummary([account({ driver: ProviderDriverKind.make("codex") })])).toBe(
      "Codex",
    );
  });

  it("counts pooled accounts and only mentions environments when there is more than one", () => {
    const here = { environmentId: local, label: "local" };
    expect(
      pooledAccountsSummary([
        account({ key: "a", environments: [here] }),
        account({ key: "b", environments: [here] }),
      ]),
    ).toBe("2 accounts");
    expect(
      pooledAccountsSummary([
        account({ key: "a", environments: [here] }),
        account({ key: "b", environments: [{ environmentId: remote, label: "remote" }] }),
      ]),
    ).toBe("2 accounts · 2 environments");
  });

  it("has nothing to say without accounts", () => {
    expect(pooledAccountsSummary([])).toBeNull();
  });
});
