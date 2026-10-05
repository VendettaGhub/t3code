import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "../providerUsageLimits.ts";
import {
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
  recordClaudeUsageResponse,
} from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            // Newer CLIs add this on top of the typed keys; the pinned SDK
            // typings do not know it yet.
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("reports API key and Bedrock accounts as unsupported", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
  });

  it("preserves limits and allows streamed recovery when subscription usage fails", () => {
    const { limits, names } = claudeUsageResponseToLimits({
      checkedAt,
      response: { rate_limits_available: true, rate_limits: null },
    });
    expect(limits).toEqual({ checkedAt, windows: [], unavailable: { reason: "probeFailed" } });
    expect(names).toEqual(noNames);

    const update = claudeRateLimitEventToUpdate(
      { status: "allowed", rateLimitType: "five_hour", utilization: 0.54 },
      names,
    )!;
    const recovered = applyUsageLimitsUpdate({ previous: limits, checkedAt, update });
    expect(recovered).toEqual({
      checkedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 54,
          windowDurationMins: 300,
        },
      ],
    });
    expect(resolveUsageLimitsAfterProbe({ published: recovered, probed: limits })).toBe(recovered);
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("recordClaudeUsageResponse", () => {
  effectIt.effect(
    "retains scoped event names after a failed read but clears them for unsupported accounts",
    () =>
      Effect.gen(function* () {
        const namesRef = yield* Ref.make({ overageIncluded: "Fable" as string | undefined });
        yield* recordClaudeUsageResponse(namesRef, {
          checkedAt,
          response: { rate_limits_available: true, rate_limits: null },
        });
        const names = yield* Ref.get(namesRef);
        expect(
          claudeRateLimitEventToUpdate(
            {
              status: "allowed",
              rateLimitType: "seven_day_overage_included" as never,
              utilization: 0.4,
            },
            names,
          )?.windows[0],
        ).toMatchObject({ id: "seven_day_fable", usedPercent: 40 });
        yield* recordClaudeUsageResponse(namesRef, {
          checkedAt,
          response: { rate_limits_available: false, rate_limits: null },
        });
        expect(yield* Ref.get(namesRef)).toEqual(noNames);
      }),
  );
});

describe("claudeRateLimitEventToUpdate", () => {
  it("prefers a unified account window over the duplicate legacy field", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 0.9,
          ...({ unifiedWindows: { five_hour: { utilization: 0.2 } } } as object),
        },
        noNames,
      )?.windows,
    ).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 20,
        windowDurationMins: 300,
      },
    ]);
  });
  it("recovers both windows from a unified event without top-level utilization", () => {
    const previous = claudeUsageResponseToLimits({
      checkedAt,
      response: { rate_limits_available: true, rate_limits: null },
    }).limits;
    const update = claudeRateLimitEventToUpdate(
      {
        status: "allowed",
        resetsAt: 1791055200,
        rateLimitType: "five_hour",
        overageStatus: "allowed",
        overageResetsAt: 1793491200,
        isUsingOverage: false,
        ...({
          unifiedWindows: {
            five_hour: { utilization: 0.08, resetsAt: 1791055200 },
            seven_day: { utilization: 0.01, resetsAt: 1791608400 },
          },
        } as object),
      },
      noNames,
    );
    expect(update).toEqual({
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 8,
          windowDurationMins: 300,
          resetsAt: "2026-10-03T19:20:00.000Z",
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 1,
          windowDurationMins: 10080,
          resetsAt: "2026-10-10T05:00:00.000Z",
        },
      ],
    });
    expect(applyUsageLimitsUpdate({ previous, checkedAt, update: update! })).toEqual({
      checkedAt,
      windows: update!.windows,
    });
  });

  it("ignores malformed unified windows and nonfinite utilization", () => {
    for (const unifiedWindows of [
      null,
      [],
      "invalid",
      {
        five_hour: { utilization: NaN, resetsAt: 1791055200 },
        seven_day: { utilization: "0.1" },
        unknown: { utilization: 0.1 },
      },
    ]) {
      expect(
        claudeRateLimitEventToUpdate(
          {
            status: "allowed",
            ...({ unifiedWindows } as object),
          },
          noNames,
        ),
      ).toBeUndefined();
    }
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: Infinity,
        },
        noNames,
      ),
    ).toBeUndefined();
  });

  it("keeps scoped events alongside unified windows and omits invalid resets", () => {
    const update = claudeRateLimitEventToUpdate(
      {
        status: "allowed",
        rateLimitType: "seven_day_overage_included" as never,
        utilization: 0.4,
        resetsAt: Infinity,
        ...({
          unifiedWindows: {
            five_hour: { utilization: 0.08, resetsAt: "invalid" },
            seven_day: { utilization: Infinity },
          },
        } as object),
      },
      { overageIncluded: "Fable" },
    );
    expect(update?.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 8,
        windowDurationMins: 300,
      },
      {
        id: "seven_day_fable",
        kind: "weekly",
        label: "Weekly · Fable",
        usedPercent: 40,
        windowDurationMins: 10080,
      },
    ]);
  });

  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    // No probe has named the bucket yet: guessing would open a stray row.
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("ignores windows the page does not render and events without a utilization", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1 },
        noNames,
      ),
    ).toBeUndefined();
    expect(
      claudeRateLimitEventToUpdate({ status: "rejected", rateLimitType: "five_hour" }, noNames),
    ).toBeUndefined();
  });
});
