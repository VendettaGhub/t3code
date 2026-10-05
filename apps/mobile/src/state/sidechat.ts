import {
  forkSidechat,
  type SidechatForkInput as ThreadForkInput,
} from "@t3tools/client-runtime/operations";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** The mobile client speaks the server's native thread.fork handshake directly. */
export const sidechatEnvironment = {
  source: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile:sidechat:source",
    tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
    staleTimeMs: 0,
  }),
  fork: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:thread:fork",
    execute: (input: ThreadForkInput) => forkSidechat({ ...input, creationSource: "mobile" }),
    concurrency: {
      mode: "singleFlight" as const,
      key: (target: { readonly environmentId: string; readonly input: ThreadForkInput }) =>
        `${target.environmentId}:${target.input.sourceThreadId}`,
    },
  }),
};

export type { ThreadForkInput };
