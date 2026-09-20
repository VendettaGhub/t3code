import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Native provider fork. The server owns context retention and target creation. */
export const sidechatEnvironment = {
  fork: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "web:thread:fork",
    tag: WS_METHODS.threadFork,
    concurrency: {
      mode: "singleFlight",
      key: (target) => `${target.environmentId}:${target.input.sourceThreadId}`,
    },
  }),
};
