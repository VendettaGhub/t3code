import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { unwrapSidechatFork } from "./sidechat";
import type { ThreadForkResult } from "../sidechats/sidechatModel";

describe("V2 sidechat command errors", () => {
  it("hides untyped client failures, defects and legacy error envelopes", () => {
    const diagnostic = new Error("PRIVATE_MESSAGE_SENTINEL C:/private/path");
    for (const cause of [
      Cause.fail(diagnostic),
      Cause.die(diagnostic),
      Cause.fail({ _tag: "ThreadForkFailedError", reason: "history-mismatch", cause: diagnostic }),
    ]) {
      expect(() =>
        unwrapSidechatFork(AsyncResult.failure<ThreadForkResult, unknown>(cause)),
      ).toThrow(/^The sidechat could not be created on this environment\.$/);
    }
  });
});
