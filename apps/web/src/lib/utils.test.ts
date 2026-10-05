import { describe, assert, it } from "vite-plus/test";
import { cn, getLocalFileManagerName, isWindowsPlatform } from "./utils";

it("preserves both integrated composer font sizes beside text colors", () => {
  assert.strictEqual(
    cn("text-sidechat", "text-muted-foreground"),
    "text-sidechat text-muted-foreground",
  );
  assert.strictEqual(
    cn("text-usage-ring", "text-muted-foreground"),
    "text-usage-ring text-muted-foreground",
  );
});

describe("getLocalFileManagerName", () => {
  it.each([
    ["MacIntel", "Finder"],
    ["Win32", "File Explorer"],
    ["Linux", "Files"],
  ])("uses the %s file manager name", (platform, expected) => {
    assert.strictEqual(getLocalFileManagerName(platform), expected);
  });
});

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});
