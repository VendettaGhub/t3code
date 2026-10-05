import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { UsageLimitsReport } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatResetsIn,
} from "@t3tools/shared/usageLimits";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Circle, Svg } from "react-native-svg";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { environmentPresentations } from "../../state/presentation";
import { useProviderColors } from "../usage/usageProviders";
import {
  collectComposerUsageRings,
  composerDriverRank,
  formatResetCountdown,
  groupComposerUsageRings,
  usageRingColor,
  type ComposerUsageRing,
} from "./ComposerUsageLimits.logic";

const RING_SIZE = 30;

/**
 * One pooled window: an arc that fills clockwise with the share consumed, the
 * time to its reset inside it, and the window marker beside it. The interior
 * label does not scale with the text setting because the ring geometry is
 * fixed; the marker outside it does, up to a bound the row can absorb.
 */
function ComposerUsageRing({
  ring,
  now,
}: {
  readonly ring: ComposerUsageRing;
  readonly now: number;
}) {
  const center = RING_SIZE / 2;
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  const color = usageRingColor(ring.usedPercent);
  const countdown = formatResetCountdown(ring.resetsAt, now);
  return (
    <View className="flex-row items-center gap-0.5">
      <View className="size-[30px] items-center justify-center">
        <Svg
          accessible={false}
          height={RING_SIZE}
          pointerEvents="none"
          style={{ position: "absolute" }}
          width={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        >
          <Circle
            cx={center}
            cy={center}
            fill="none"
            opacity={0.55}
            r={radius}
            stroke="#737373"
            strokeWidth={2.5}
          />
          {ring.usedPercent > 0 ? (
            <Circle
              cx={center}
              cy={center}
              fill="none"
              r={radius}
              stroke={color}
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={circumference * (1 - ring.usedPercent / 100)}
              strokeLinecap="round"
              strokeWidth={2.5}
              transform={`rotate(-90 ${center} ${center})`}
            />
          ) : null}
        </Svg>
        {countdown ? (
          <Text
            allowFontScaling={false}
            className="text-[9px] font-t3-bold tabular-nums text-foreground"
          >
            {countdown}
          </Text>
        ) : null}
      </View>
      <Text
        maxFontSizeMultiplier={1.2}
        numberOfLines={1}
        className="text-[9px] font-t3-bold text-foreground-tertiary"
      >
        {ring.shortLabel}
      </Text>
    </View>
  );
}

/** Minute resolution is all the countdowns show, so one tick a minute keeps them honest. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Pooled, consumed-quota affordance that stays visible above the composer.
 * Each driver owns an equal column split by a hairline, so Claude and Codex
 * stay in the same place whatever each of them reports.
 */
export function ComposerUsageLimitRings({ onPress }: { readonly onPress: () => void }) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const now = useMinuteClock();
  const rings = useMemo(() => collectComposerUsageRings(presentations, now), [now, presentations]);
  if (rings.length === 0) return null;

  const label = rings
    .map((ring) => `${ring.driverLabel} ${ring.windowLabel}, ${ring.usedPercent}% used`)
    .join("; ");
  const groups = groupComposerUsageRings(rings);
  return (
    <Pressable
      accessibilityLabel={`Usage limits: ${label}`}
      accessibilityRole="button"
      className="mb-2 min-h-[38px] w-full flex-row items-stretch rounded-[18px] border border-border-subtle bg-card px-1 py-1 active:opacity-60"
      onPress={onPress}
    >
      {groups.map((group, index) => (
        <Fragment key={group.driver}>
          {index > 0 ? <View className="my-1 w-px shrink-0 bg-border-subtle" /> : null}
          <View className="min-w-0 flex-1 flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1 px-1">
            <ProviderIcon provider={group.driver} size={18} />
            {group.rings.map((ring) => (
              <ComposerUsageRing key={`${ring.kind}:${ring.id}`} now={now} ring={ring} />
            ))}
          </View>
        </Fragment>
      ))}
    </Pressable>
  );
}

const DRIVER_LABEL: Partial<Record<string, string>> = { codex: "Codex", claudeAgent: "Claude" };

/** One pooled window as a single line: who and which window, what is left, and when it comes back. */
function PooledWindowRow({
  color,
  driver,
  label,
  remainingPercent,
  resetsIn,
}: {
  readonly color: string;
  readonly driver: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetsIn: string | null;
}) {
  return (
    <View className="gap-1.5 py-1.5">
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider={driver} size={14} />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
          {label}
        </Text>
        <Text className="text-xs font-t3-medium tabular-nums text-foreground">
          {remainingPercent}% left
        </Text>
        {resetsIn ? (
          <Text className="text-xs tabular-nums text-foreground-tertiary">
            {resetsIn.replace("resets in ", "↻ ").replace("resets ", "↻ ")}
          </Text>
        ) : null}
      </View>
      <View className="h-1.5 overflow-hidden rounded-full bg-subtle">
        <View
          className="h-full rounded-full"
          style={{ width: `${remainingPercent}%`, backgroundColor: color }}
        />
      </View>
    </View>
  );
}

/**
 * The /usage-limits result, docked above the composer. It stays a flat list of
 * pooled windows rather than the Usage → Limits cards: the composer has room
 * for a glance, and the full view is one tap away.
 */
export function ComposerUsageLimits({
  report,
  onClose,
}: {
  readonly report: UsageLimitsReport;
  readonly onClose: () => void;
}) {
  const navigation = useNavigation();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const colors = useProviderColors();
  const now = Date.parse(report.createdAt);
  const { height } = useWindowDimensions();
  // Same driver order as the ring row above, so tapping it does not reshuffle.
  const pools = useMemo(
    () =>
      collectLimitPools(collectLimitAccounts(presentations), now)
        .map((pool, index) => ({ pool, index }))
        .sort(
          (left, right) =>
            composerDriverRank(String(left.pool.driver)) -
              composerDriverRank(String(right.pool.driver)) || left.index - right.index,
        )
        .map(({ pool }) => pool),
    [now, presentations],
  );
  const driverColor = (driver: string) =>
    driver === "claudeAgent" ? colors.claude : driver === "grok" ? colors.grok : colors.codex;
  return (
    <View className="overflow-hidden rounded-[20px] border-continuous bg-card">
      <ScrollView
        bounces={false}
        showsVerticalScrollIndicator={false}
        style={{ maxHeight: Math.round(height * 0.4) }}
      >
        <View className="flex-row items-center gap-3 px-4 pt-3">
          <Text className="min-w-0 flex-1 text-base text-foreground">Usage limits</Text>
          <Pressable
            accessibilityLabel="Open full usage"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => {
              // The full view supersedes the glance, so the dock closes behind it.
              onClose();
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsUsage" },
              });
            }}
            className="p-1 active:opacity-60"
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={14}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
          <Pressable
            accessibilityLabel="Dismiss usage limits"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onClose}
            className="-me-1 p-1 active:opacity-60"
          >
            <SymbolView
              name="xmark"
              size={14}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </View>
        <View className="px-4 pb-3 pt-1">
          {pools.length === 0 && report.notices.length === 0 ? (
            <Text className="py-3 text-sm text-foreground-muted">
              No provider currently reports subscription limits.
            </Text>
          ) : null}
          {pools.flatMap((pool) =>
            pool.windows.map((window) => (
              <PooledWindowRow
                key={`${pool.driver}:${window.kind}:${window.id}`}
                color={driverColor(String(pool.driver))}
                driver={String(pool.driver)}
                label={`${DRIVER_LABEL[pool.driver] ?? pool.driver} · ${window.label}`}
                remainingPercent={window.remainingPercent}
                resetsIn={
                  window.resets[0] ? formatResetsIn(window.resets[0].member.window, now) : null
                }
              />
            )),
          )}
          {report.notices.map((notice) => (
            <Text key={notice} className="pt-1.5 text-xs text-foreground-muted">
              {notice}
            </Text>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
