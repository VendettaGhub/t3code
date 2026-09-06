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
  PopoverTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<{ children?: ReactNode }>;
    children?: ReactNode;
  }) => cloneElement(render, undefined, children ?? render.props.children),
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
  it("renders provider-grouped rings in their stable slot order", () => {
    const markup = renderToStaticMarkup(
      <ProviderLimitChips
        environmentId={EnvironmentId.make("environment-local")}
        selectedModel="claude-fable-5"
      />,
    );

    expect(markup).toContain('data-provider-logo="claude"');
    expect(markup).toContain('aria-label="Claude 5-hour session, 45% used"');
    expect(markup).toContain('aria-label="Claude weekly, 77% used"');
    expect(markup).toContain('data-provider-logo="codex"');
    expect(markup).toContain('aria-label="Codex 5-hour session, 58% used"');
    expect(markup).toContain('aria-label="Codex weekly, 31% used"');
    expect(markup).toContain("font-mono");
    expect(markup).toContain("leading-none");
    expect(markup.indexOf('aria-label="Claude 5-hour session')).toBeLessThan(
      markup.indexOf('aria-label="Claude weekly'),
    );
    expect(markup.indexOf('aria-label="Codex 5-hour session')).toBeLessThan(
      markup.indexOf('aria-label="Codex weekly'),
    );
  });

  it("keeps full limit identity and percentages available to assistive technology", () => {
    const markup = renderToStaticMarkup(
      <ProviderLimitChips
        environmentId={EnvironmentId.make("environment-local")}
        selectedModel="gpt-5.6-sol"
        compact
      />,
    );

    expect(markup).toContain('data-provider-logo="claude"');
    expect(markup).toContain('data-provider-logo="codex"');
    expect(markup).toContain("45% used");
    expect(markup).toContain("77% used");
    expect(markup).toContain("58% used");
    expect(markup).toContain("31% used");
  });

  it("keeps extra usage out of the composer rings", () => {
    const markup = renderToStaticMarkup(
      <ProviderLimitChips
        environmentId={EnvironmentId.make("environment-local")}
        selectedModel="claude-fable-5"
      />,
    );
    expect(markup).not.toContain(">A<");
    expect(markup).not.toContain("Extra usage");
    expect(markup).not.toContain("24.78");
  });
});
