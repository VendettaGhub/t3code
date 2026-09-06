const { test } = require("node:test");
const assert = require("node:assert/strict");
const { schema, patchWeb, patchDesktop } = require("./t3-tray-stage.cjs");
test("copies only schema defaults and patch fields, not quit callbacks", () => {
  const s =
    "confirmQuit: Boolean.pipe(withDefault(true)),confirmQuit: optionalKey(Boolean),confirmQuit:ts.confirmQuit,";
  const patched = schema(s);
  assert.match(patched, /closeToTray: Boolean.pipe/);
  assert.match(patched, /closeToTray: optionalKey/);
  assert.ok(!patched.includes("closeToTray:ts.confirmQuit"));
  assert.equal(schema(patched), patched);
});
test("copies both minified client schema fields", () => {
  const p = schema("confirmQuit:z.pipe(G(j(!0))),confirmQuit:P(z),");
  assert.equal(
    p,
    "confirmQuit:z.pipe(G(j(!0))),closeToTray:z.pipe(G(j(!0))),confirmQuit:P(z),closeToTray:P(z),",
  );
});
test("refuses unknown web/desktop builds rather than guessing", () => {
  assert.throws(() => patchWeb("unrecognized build"), /anchor/);
  assert.throws(() => patchDesktop("unrecognized build", ""), /missing/);
});
