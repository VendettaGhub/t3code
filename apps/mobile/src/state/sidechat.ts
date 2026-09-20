import { WS_METHODS, type ThreadForkInput, type ThreadForkResult } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** The mobile client speaks the server's native thread.fork handshake directly. */
export const sidechatEnvironment = {
  fork: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:thread:fork",
    tag: WS_METHODS.threadFork,
    concurrency: {
      mode: "singleFlight" as const,
      key: (target: { readonly environmentId: string; readonly input: ThreadForkInput }) =>
        `${target.environmentId}:${target.input.sourceThreadId}`,
    },
  }),
};

export type { ThreadForkInput, ThreadForkResult };
