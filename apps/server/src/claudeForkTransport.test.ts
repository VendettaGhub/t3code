import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import {
  collectClaudeForkOutput,
  runClaudeForkWorker,
  decodeClaudeForkPrefix,
} from "./claudeForkTransport.js";
import { NodeServices } from "@effect/platform-node";
import { ChildProcess } from "effect/unstable/process";

const run = (script: string) =>
  runClaudeForkWorker(ChildProcess.make(process.execPath, ["-e", script])).pipe(
    Effect.provide(NodeServices.layer),
  );

const expectFailure = <A, E, R>(operation: Effect.Effect<A, E, R>, message?: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(operation);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && message !== undefined)
      expect(Cause.pretty(exit.cause)).toContain(message);
  });

describe("bounded Claude fork transport", () => {
  it.live("loads the helper through the native source runtime", () =>
    Effect.gen(function* () {
      const moduleUrl = new URL("./claudeForkTransport.ts", import.meta.url).href;
      expect(yield* run(`await import(${JSON.stringify(moduleUrl)})`)).toBe("");
    }),
  );
  it.live("accepts complete output only after successful child exit", () =>
    Effect.gen(function* () {
      expect(yield* run('process.stdout.write("{\\\"ok\\\":true}")')).toBe('{"ok":true}');
    }),
  );
  it.live("rejects output from a nonzero child exit", () =>
    expectFailure(
      run('process.stdout.write("{\\\"ok\\\":true}");process.exitCode=2'),
      "worker failed",
    ),
  );
  it.live("terminates a child exceeding the stderr limit", () =>
    expectFailure(
      run('process.stderr.write("x".repeat(65537));setInterval(()=>{},1000)'),
      "output limit",
    ),
  );
  it.live("terminates a child exceeding the 32 MiB stdout limit", () =>
    expectFailure(
      run('process.stdout.write("x".repeat(32*1024*1024+1));setInterval(()=>{},1000)'),
      "output limit",
    ),
  );
  it.live("rejects truncated JSON even when the child exits successfully", () =>
    Effect.gen(function* () {
      const output = yield* run('process.stdout.write("{\\\"requestId\\\":")');
      expect(() =>
        decodeClaudeForkPrefix(output, {
          sourceSessionId: "source",
          targetSessionId: "target",
          checkpointId: "checkpoint",
          requestId: "request",
        }),
      ).toThrow();
    }),
  );
  it.live("supports a caller deadline for a stalled child", () =>
    expectFailure(run("setInterval(()=>{},1000)").pipe(Effect.timeout("100 millis"))),
  );
  it("rejects partial JSON and cross-request response bindings", () => {
    const expected = {
      sourceSessionId: "source",
      targetSessionId: "target",
      checkpointId: "checkpoint",
      requestId: "request",
    };
    expect(() => decodeClaudeForkPrefix('{"requestId":', expected)).toThrow();
    const response = { ...expected, projectKey: "fixture", compacted: false, entries: [] };
    expect(decodeClaudeForkPrefix(JSON.stringify(response), expected)).toEqual(response);
    expect(() =>
      decodeClaudeForkPrefix(JSON.stringify({ ...response, targetSessionId: "other" }), expected),
    ).toThrow("binding");
    expect(() =>
      decodeClaudeForkPrefix(JSON.stringify({ ...response, projectKey: "../escape" }), expected),
    ).toThrow();
  });
  it.effect("counts UTF-8 bytes across chunk boundaries", () =>
    Effect.gen(function* () {
      const bytes = Buffer.from("a€b");
      const stream = Stream.fromIterable([bytes.subarray(0, 2), bytes.subarray(2)]);
      expect(yield* collectClaudeForkOutput(stream, 5)).toBe("a€b");
    }),
  );
  it.effect("fails on overflow without consuming the rest of the stream", () =>
    Effect.gen(function* () {
      let readPastLimit = false;
      const stream = Stream.concat(
        Stream.make(Buffer.from("1234"), Buffer.from("5")),
        Stream.fromEffect(
          Effect.sync(() => {
            readPastLimit = true;
            return Buffer.from("never consumed");
          }),
        ),
      );
      yield* expectFailure(collectClaudeForkOutput(stream, 4), "output limit");
      expect(readPastLimit).toBe(false);
    }),
  );
  it.effect("rejects truncated UTF-8 rather than replacing it", () =>
    expectFailure(collectClaudeForkOutput(Stream.make(new Uint8Array([0xe2, 0x82])), 10), "UTF-8"),
  );
});
