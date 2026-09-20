import {
  StackActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";

import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { sidechatEnvironment } from "../../state/sidechat";
import {
  canStartSidechat,
  formatSidechatOrigin,
  sidechatChildren,
  type SidechatParentState,
} from "./sidechatModel";

type Props = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function toParentState(thread: {
  readonly latestTurn: { readonly state: string } | null;
  readonly session: { readonly activeTurnId: string | null } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly backgroundLiveness?: "working" | "monitoring" | null;
}): SidechatParentState {
  return {
    latestTurn: thread.latestTurn,
    activeTurnId: thread.session?.activeTurnId ?? null,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    backgroundLiveness: thread.backgroundLiveness ?? null,
  };
}

export function SidechatListScreen(props: Props) {
  const navigation = useNavigation();
  const shells = useThreadShells();
  const serverConfigs = useServerConfigs();
  const forkThread = useAtomCommand(sidechatEnvironment.fork, "Start sidechat");
  const [starting, setStarting] = useState(false);
  const mountedRef = useRef(false);
  const focusedRef = useRef(false);
  const routeGenerationRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      routeGenerationRef.current += 1;
      return () => {
        focusedRef.current = false;
        routeGenerationRef.current += 1;
      };
    }, []),
  );
  // Reuse the id after a lost response so a retry can be deduplicated server-side.
  const requestIdRef = useRef<{
    readonly sourceThreadId: string;
    readonly requestId: string;
  } | null>(null);
  const environmentId = props.route.params.environmentId;
  const sourceThreadId = props.route.params.threadId;
  const sourceThread = shells.find(
    (thread) => String(thread.environmentId) === environmentId && String(thread.id) === sourceThreadId,
  );
  const children = useMemo(
    () =>
      sourceThread === undefined
        ? []
        : sidechatChildren(
            sourceThread.id,
            shells.filter((thread) => String(thread.environmentId) === environmentId),
          ).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [environmentId, shells, sourceThread],
  );
  const provider = sourceThread
    ? serverConfigs
        .get(sourceThread.environmentId)
        ?.providers.find(
          (candidate) =>
            candidate.instanceId ===
            (sourceThread.session?.providerInstanceId ?? sourceThread.modelSelection.instanceId),
        )
    : null;
  const canStart = canStartSidechat({
    parent: sourceThread ? toParentState(sourceThread) : null,
    supportsThreadFork: provider?.supportsThreadFork,
  });

  const openSidechat = (threadId: string, replace = false) => {
    const params = {
      environmentId,
      threadId: sourceThreadId,
      sidechatId: threadId,
    };
    if (replace) {
      navigation.dispatch(StackActions.replace("ThreadSidechat", params));
    } else {
      void navigation.navigate("ThreadSidechat", params);
    }
  };

  const requestIdForSource = (sourceId: string): string => {
    const current = requestIdRef.current;
    if (current?.sourceThreadId === sourceId) return current.requestId;
    const requestId = TrimmedNonEmptyString.make(uuidv4());
    requestIdRef.current = { sourceThreadId: sourceId, requestId };
    return requestId;
  };

  const startSidechat = async () => {
    if (sourceThread === undefined || !canStart.allowed || starting) return;
    setStarting(true);
    const requestGeneration = routeGenerationRef.current;
    try {
      const result = await forkThread({
        environmentId: sourceThread.environmentId,
        input: {
          sourceThreadId: sourceThread.id,
          requestId: requestIdForSource(String(sourceThread.id)),
        },
      });
      if (result._tag === "Success") {
        requestIdRef.current = null;
        if (
          !mountedRef.current ||
          !focusedRef.current ||
          routeGenerationRef.current !== requestGeneration ||
          !navigation.isFocused()
        ) {
          return;
        }
        openSidechat(String(result.value.targetThreadId), true);
      } else {
        Alert.alert("Could not start sidechat", "The source thread could not be forked. Try again when it is idle.");
      }
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  };

  if (sourceThread === undefined) {
    return (
      <ScrollView className="flex-1 bg-screen" contentContainerClassName="flex-grow justify-center px-6">
        <EmptyState
          variant="plain"
          title="Source thread unavailable"
          detail="This sidechat list needs the source thread to be present in the current workspace snapshot."
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView className="flex-1 bg-screen" contentContainerClassName="px-4 pb-8 pt-3">
      <View className="border-b border-border pb-4">
        <Text className="text-lg font-t3-bold text-foreground">Side question history</Text>
        <Text className="mt-1 font-sans text-sm text-foreground-muted">
          Native forks stay in this workspace and do not copy the source history. Files are shared,
          so concurrent edits can conflict; file restore requires an isolated worktree.
        </Text>
        <Pressable
          accessibilityLabel="Start new side question"
          accessibilityRole="button"
          disabled={!canStart.allowed || starting}
          onPress={() => void startSidechat()}
          className="mt-4 min-h-12 flex-row items-center justify-center rounded-xl bg-primary px-4 py-3 active:opacity-70 disabled:opacity-45"
        >
          {starting ? <ActivityIndicator color="#fff" /> : <Text className="font-t3-bold text-primary-foreground">New side question</Text>}
        </Pressable>
        {!canStart.allowed ? (
          <Text className="mt-2 font-sans text-xs text-foreground-muted">{canStart.reason}</Text>
        ) : null}
      </View>

      {children.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No sidechats yet"
          detail="Start one after the source turn has completed."
        />
      ) : (
        <View className="mt-1">
          {children.map((thread) => (
            <Pressable
              key={String(thread.id)}
              accessibilityLabel={`Resume side question ${thread.title}`}
              accessibilityRole="button"
              onPress={() => openSidechat(String(thread.id))}
              className="border-b border-border px-1 py-4 active:opacity-70"
            >
              <Text className="font-t3-bold text-base text-foreground">{thread.title}</Text>
              <Text className="mt-1 font-sans text-sm text-foreground-muted">
                {thread.origin ? formatSidechatOrigin(thread.origin) : "Native sidechat"}
              </Text>
              <Text className="mt-2 font-t3-bold text-xs text-primary">Resume</Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
