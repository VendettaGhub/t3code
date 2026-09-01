import {
  EnvironmentId,
  type ProviderLimitsSnapshot,
  type ProviderLimitsState,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  limitsByEnvironment: new Map<string, ProviderLimitsState>(),
  accountIdsByEnvironment: new Map<string, { claude?: string; codex?: string }>(),
  refresh: vi.fn(),
}));

vi.mock("../../state/providerLimits", () => ({
  useAllProviderLimits: () => ({
    environments: [...testState.limitsByEnvironment].map(([environmentId, data]) => ({
      environmentId,
      label: environmentId,
      data,
      error: null,
      isPending: false,
      accountIds: testState.accountIdsByEnvironment.get(environmentId) ?? {},
    })),
    refresh: testState.refresh,
  }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));

import { ProviderLimitsPanel } from "./ProviderLimitsPanel";

const snapshot = (
  provider: "claude" | "codex",
  overrides: Partial<ProviderLimitsSnapshot> = {},
): ProviderLimitsSnapshot => ({
  provider,
  capturedAt: Date.now(),
  source: "read",
  authState: "ok",
  parseWarnings: [],
  buckets: [],
  ...overrides,
});

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

beforeEach(() => {
  testState.refresh.mockReset();
  testState.limitsByEnvironment.clear();
  testState.accountIdsByEnvironment.clear();
  testState.limitsByEnvironment.set(localEnvironmentId, {
    claude: snapshot("claude", {
      planType: "max",
      buckets: [
        {
          bucketId: "claude-subscription",
          displayName: "Claude subscription",
          kind: "session",
          primary: { label: "5h", usedPercent: 42 },
          secondary: { label: "Week", usedPercent: 67 },
          spend: {
            used: 24.78,
            limit: 200,
            remainingPercent: 87.61,
            currency: "EUR",
          },
        },
      ],
    }),
    lastActualRoute: {
      provider: "codex",
      requestedProvider: "claude",
      model: "gpt-5.6-luna",
      at: Date.now(),
      fallback: true,
      statusCode: 429,
    },
  });
  testState.limitsByEnvironment.set(remoteEnvironmentId, {
    codex: snapshot("codex", {
      planType: "pro",
      buckets: [
        {
          bucketId: "codex-subscription",
          displayName: "Codex subscription",
          kind: "session",
          primary: { label: "5h", usedPercent: 18 },
          secondary: { label: "Week", usedPercent: 53 },
        },
      ],
    }),
  });
});

describe("ProviderLimitsPanel", () => {
  it("renders account quotas without device sections and refreshes them together", () => {
    const markup = renderToStaticMarkup(<ProviderLimitsPanel />);

    expect(markup).not.toContain("environment-local");
    expect(markup).not.toContain("environment-remote");
    expect(markup).toContain('aria-label="Refresh live subscription quota"');
    expect(markup).toContain("max");
    expect(markup).toContain("pro");
  });

  it("renders a shared OAuth account once", () => {
    testState.limitsByEnvironment.set(remoteEnvironmentId, {
      codex: snapshot("codex", {
        planType: "pro",
        capturedAt: Date.now() + 1,
        buckets: [
          {
            bucketId: "codex-subscription",
            displayName: "Codex subscription",
            kind: "weekly",
            primary: { label: "Week", usedPercent: 53 },
          },
        ],
      }),
    });
    testState.accountIdsByEnvironment.set(localEnvironmentId, { codex: "same@example.com" });
    testState.accountIdsByEnvironment.set(remoteEnvironmentId, { codex: "SAME@example.com" });
    const local = testState.limitsByEnvironment.get(localEnvironmentId);
    testState.limitsByEnvironment.set(localEnvironmentId, {
      ...local,
      codex: snapshot("codex", {
        buckets: [
          {
            bucketId: "codex-subscription",
            displayName: "Codex subscription",
            kind: "weekly",
            primary: { label: "Week", usedPercent: 52 },
          },
        ],
      }),
    });

    const markup = renderToStaticMarkup(<ProviderLimitsPanel />);
    expect(markup).toContain("53% used");
    expect(markup).not.toContain("52% used");
  });

  it("shows primary and secondary windows and reported spend", () => {
    testState.limitsByEnvironment.delete(remoteEnvironmentId);
    const markup = renderToStaticMarkup(<ProviderLimitsPanel />);

    expect(markup).toContain('aria-label="Claude subscription 5h"');
    expect(markup).toContain('aria-label="Claude subscription Week"');
    expect(markup).toContain("42% used");
    expect(markup).toContain("67% used");
    expect(markup).toContain("Spend");
    expect(markup).toContain("24.78");
    expect(markup).toContain("200");
  });

  it("shows the provider that actually served the last request", () => {
    testState.limitsByEnvironment.delete(remoteEnvironmentId);
    const markup = renderToStaticMarkup(<ProviderLimitsPanel />);

    expect(markup).toContain("Last request served by Codex");
    expect(markup).toContain("fallback from Claude");
    expect(markup).toContain("gpt-5.6-luna");
    expect(markup).toContain("HTTP 429");
  });

  it("explains the empty multi-environment state", () => {
    testState.limitsByEnvironment.clear();
    const markup = renderToStaticMarkup(<ProviderLimitsPanel />);

    expect(markup).toContain("No live quota reported.");
  });
});
