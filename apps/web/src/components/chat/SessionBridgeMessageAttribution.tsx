import type { EnvironmentId } from "@t3tools/contracts";
import {
  resolveSessionBridgeThreadRef,
  type SessionBridgeOrigin,
} from "@t3tools/shared/sessionBridgeMessage";
import { Link } from "@tanstack/react-router";

import { useEnvironments } from "~/state/environments";
import { useThreadShells } from "~/state/entities";

export function SessionBridgeMessageAttribution({
  origin,
  currentEnvironmentId,
}: {
  readonly origin: SessionBridgeOrigin;
  readonly currentEnvironmentId: EnvironmentId;
}) {
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
    <div className="mb-1 text-xs text-muted-foreground" data-session-bridge-attribution="true">
      From:{" "}
      {source && title ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: source.environmentId, threadId: source.id }}
          aria-label={`Open ${title} on ${environmentLabel}`}
          className="min-w-0 max-w-full rounded-sm break-words text-inherit underline decoration-current/40 underline-offset-2 hover:text-foreground hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {title}
        </Link>
      ) : (
        <span>{title ?? "Unavailable thread"}</span>
      )}
      <span> · {environmentLabel}</span>
      {origin.sourceDisclosure ? <span> · {origin.sourceDisclosure}</span> : null}
    </div>
  );
}
