import { EnvironmentId, type ProviderLimitsState } from "@t3tools/contracts";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  limits: null as ProviderLimitsState | null,
  refresh: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/providerLimits", () => ({
  useProviderLimits: () => ({
    data: testState.limits,
    error: null,
    isPending: false,
    refresh: testState.refresh,
  }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, undefined, children),
}));

import { ProviderLimitChips } from "./ProviderLimitChips";

beforeEach(() => {
  testState.refresh.mockReset();
  testState.limits = {
    claude: {
      provider: "claude",
      capturedAt: Date.now(),
      source: "read",
      authState: "ok",
      parseWarnings: [],
      buckets: [
        {
          bucketId: "subscription",
          displayName: "Claude subscription",
          kind: "session",
          primary: { label: "5h", usedPercent: 45 },
          secondary: { label: "Week", usedPercent: 77 },
          spend: {
            used: 24.78,
            limit: 200,
            remainingPercent: 87.61,
            currency: "EUR",
          },
        },
      ],
    },
    codex: {
      provider: "codex",
      capturedAt: Date.now(),
      source: "read",
      authState: "ok",
      parseWarnings: [],
      buckets: [
        {
          bucketId: "codex",
          displayName: "Codex",
          kind: "session",
          primary: { label: "5h", usedPercent: 58 },
          secondary: { label: "Week", usedPercent: 31 },
        },
      ],
    },
  };
});

describe("ProviderLimitChips", () => {
  it("includes the limiting window label in each compact headline", () => {
    const markup = renderToStaticMarkup(
      <ProviderLimitChips
        environmentId={EnvironmentId.make("environment-local")}
        selectedModel="claude-fable-5"
      />,
    );

    expect(markup).toContain('data-provider-logo="claude"');
    expect(markup).toContain("A 77%");
    expect(markup).toContain("5h 58%");
  });

  it("keeps provider and window identity visible when the composer footer is compact", () => {
    const markup = renderToStaticMarkup(
      <ProviderLimitChips
        environmentId={EnvironmentId.make("environment-local")}
        selectedModel="gpt-5.6-sol"
        compact
      />,
    );

    expect(markup).toContain('data-provider-logo="claude"');
    expect(markup).toContain("A 77%");
    expect(markup).toContain('data-provider-logo="codex"');
    expect(markup).toContain("5h 58%");
    expect(markup).toContain("Claude subscription limits");
    expect(markup).toContain("Codex subscription limits");
  });

  it("renders primary and secondary windows plus reported spend in the details", () => {
    const markup = renderToStaticMarkup(
      <ProviderLimitChips
        environmentId={EnvironmentId.make("environment-local")}
        selectedModel="claude-fable-5"
      />,
    );

    expect(markup).toContain('aria-label="Claude subscription 5h"');
    expect(markup).toContain('aria-label="Claude subscription Week"');
    expect(markup).toContain("Spend");
    expect(markup).toContain("24.78");
    expect(markup).toContain("200");
  });
});
