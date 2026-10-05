import { describe, expect, it } from "vite-plus/test";

import {
  parseSessionBridgeMessage,
  resolveSessionBridgeThreadRef,
} from "./sessionBridgeMessage.ts";

describe("parseSessionBridgeMessage", () => {
  it("parses the current global envelope without losing its unauthenticated-source disclosure", () => {
    const title = 'Review "quoted"\nline';
    const header = `Message from T3 thread ${JSON.stringify(title)} (thread "source-1" on environment "wsl"; caller-declared source, existence-checked, not authenticated).`;
    const hint =
      ' Reply with send_message_to_thread using environmentId "wsl" and threadId "source-1"; include your own source environmentId and threadId.';
    for (const reply of ["", hint]) {
      expect(
        parseSessionBridgeMessage({
          id: "mcp-message:current",
          role: "user",
          text: `${header}${reply}\n\nBody`,
        }),
      ).toEqual({
        sourceThreadId: "source-1",
        sourceEnvironmentId: "wsl",
        body: "Body",
        sourceDisclosure: "caller-declared source, existence-checked, not authenticated",
      });
    }
    expect(
      parseSessionBridgeMessage({
        id: "mcp-message:current",
        role: "user",
        text: `${header}${hint.replace('"wsl"', '"other"')}\n\nBody`,
      }),
    ).toBeNull();
  });
  it("extracts global bridge origin and body while excluding the reply hint", () => {
    expect(
      parseSessionBridgeMessage({
        id: "mcp-message:command-1",
        role: "user",
        text: 'Message from T3 thread source-1 on environment wsl. Reply with send_message_to_thread using environmentId "wsl" and threadId "source-1".\n\nPlease check this.',
      }),
    ).toEqual({
      sourceThreadId: "source-1",
      sourceEnvironmentId: "wsl",
      body: "Please check this.",
    });
  });

  it("extracts single-server messages as same-environment origins", () => {
    expect(
      parseSessionBridgeMessage({
        id: "mcp-message:command-2",
        role: "user",
        text: "Message from T3 thread source-2. Reply with send_message_to_thread using that thread ID.\n\nContinue.",
      }),
    ).toEqual({
      sourceThreadId: "source-2",
      sourceEnvironmentId: null,
      body: "Continue.",
    });
  });

  it("leaves ordinary or malformed user text alone", () => {
    const ordinary = {
      id: "user-message-1",
      role: "user",
      text: "Message from T3 thread source-1 on environment wsl.\n\nNot a bridge message.",
    };
    expect(parseSessionBridgeMessage(ordinary)).toBeNull();
    expect(
      parseSessionBridgeMessage({
        ...ordinary,
        id: "mcp-message:",
        text: "Message from T3 thread source-1.\n\nBody",
      }),
    ).toBeNull();
    expect(
      parseSessionBridgeMessage({
        ...ordinary,
        id: "mcp-message:command-3",
        text: 'Message from T3 thread source-1 on environment wsl. Reply with send_message_to_thread using environmentId "other" and threadId "source-1".\n\nBody',
      }),
    ).toBeNull();
  });
});

describe("resolveSessionBridgeThreadRef", () => {
  const threads = [
    { id: "shared-id", environmentId: "env-a", title: "A" },
    { id: "shared-id", environmentId: "env-b", title: "B" },
    { id: "unique-id", environmentId: "env-b", title: "Unique" },
  ];

  it("prefers exact environment and thread identity", () => {
    expect(
      resolveSessionBridgeThreadRef(
        { sourceThreadId: "shared-id", sourceEnvironmentId: "env-b" },
        "env-a",
        threads,
        ["env-a", "env-b"],
      ),
    ).toBe(threads[1]);
  });

  it("resolves a configured bridge alias only when the thread ID is unique", () => {
    expect(
      resolveSessionBridgeThreadRef(
        { sourceThreadId: "unique-id", sourceEnvironmentId: "wsl" },
        "env-a",
        threads,
        ["env-a", "env-b"],
      ),
    ).toBe(threads[2]);
    expect(
      resolveSessionBridgeThreadRef(
        { sourceThreadId: "shared-id", sourceEnvironmentId: "desktop-env" },
        "env-a",
        threads,
        ["env-a", "env-b"],
      ),
    ).toBeNull();
  });

  it("uses the current environment for single-server messages", () => {
    expect(
      resolveSessionBridgeThreadRef(
        { sourceThreadId: "shared-id", sourceEnvironmentId: null },
        "env-b",
        threads,
        ["env-a", "env-b"],
      ),
    ).toBe(threads[1]);
  });

  it("does not fall back to another environment when a known source environment lacks the thread", () => {
    expect(
      resolveSessionBridgeThreadRef(
        { sourceThreadId: "shared-id", sourceEnvironmentId: "env-c" },
        "env-a",
        threads,
        ["env-a", "env-b", "env-c"],
      ),
    ).toBeNull();
  });
});
