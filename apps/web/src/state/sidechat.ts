import { forkSidechat } from "@t3tools/client-runtime/operations";
import type { ThreadForkResult } from "../sidechats/sidechatModel";
import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  createEnvironmentCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export function unwrapSidechatFork(
  result: AtomCommandResult<ThreadForkResult, unknown>,
): ThreadForkResult {
  if (result._tag === "Failure") {
    throw new Error("The sidechat could not be created on this environment.");
  }
  return result.value;
}

/** Native provider fork. The server owns context retention and target creation. */
export const sidechatEnvironment = {
  source: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "web:sidechat:source",
    tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
    staleTimeMs: 0,
  }),
  fork: createEnvironmentCommand(connectionAtomRuntime, {
    label: "web:thread:fork",
    execute: forkSidechat,
    concurrency: {
      mode: "singleFlight",
      key: (target) => `${target.environmentId}:${target.input.sourceThreadId}`,
    },
  }),
};
