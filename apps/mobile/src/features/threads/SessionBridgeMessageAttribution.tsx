import type { EnvironmentId } from "@t3tools/contracts";
import {
  resolveSessionBridgeThreadRef,
  type SessionBridgeOrigin,
} from "@t3tools/shared/sessionBridgeMessage";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironments } from "../../state/environments";
import { useThreadShells } from "../../state/entities";

export function SessionBridgeMessageAttribution({
  origin,
  currentEnvironmentId,
}: {
  readonly origin: SessionBridgeOrigin;
  readonly currentEnvironmentId: EnvironmentId;
}) {
  const navigation = useNavigation();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const source = resolveSessionBridgeThreadRef(
    origin,
    currentEnvironmentId,
    threads,
    environments.map((environment) => String(environment.environmentId)),
  );
  const environmentId = source?.environmentId ?? origin.sourceEnvironmentId ?? currentEnvironmentId;
  const environmentLabel =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    String(environmentId);
  const title = source?.title.trim() || null;

  return (
    <View className="mb-1 flex-row flex-wrap items-baseline" accessibilityLabel="Message origin">
      <Text className="font-t3-medium text-xs text-foreground-secondary">From: </Text>
      {source && title ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open ${title} on ${environmentLabel}`}
          hitSlop={8}
          className="max-w-full shrink rounded-sm"
          onPress={() =>
            navigation.navigate("Thread", {
              environmentId: String(source.environmentId),
              threadId: String(source.id),
            })
          }
        >
          <Text className="max-w-full shrink text-xs text-foreground-secondary underline">
            {title}
          </Text>
        </Pressable>
      ) : (
        <Text className="text-xs text-foreground-secondary">Unavailable thread</Text>
      )}
      <Text className="text-xs text-foreground-secondary"> · {environmentLabel}</Text>
      {origin.sourceDisclosure ? (
        <Text className="text-xs text-foreground-secondary"> · {origin.sourceDisclosure}</Text>
      ) : null}
    </View>
  );
}
