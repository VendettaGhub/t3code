// Stages only the Windows tray/settings changes. Never writes to the installed app.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
function once(s, from, to) {
  if (s.split(from).length !== 2)
    throw new Error(`Expected exactly one anchor: ${from.slice(0, 90)}`);
  return s.replace(from, to);
}
function schema(s) {
  if (s.includes("closeToTray:")) return s;
  return s.replace(/confirmQuit:([^,\n]+),/g, (all, value) => {
    if (!/pipe\(|optionalKey\(|^P\(z\)$/.test(value)) return all;
    if ([...value].filter((x) => x === "(").length !== [...value].filter((x) => x === ")").length)
      throw new Error("Unbalanced schema anchor");
    if (value.includes("pipe(") && !/(?:true|!0)\)\)+$/.test(value.trim()))
      throw new Error("Expected explicit true default");
    return `${all}closeToTray:${value},`;
  });
}
function patchDesktop(s, built) {
  if (s.includes("function installWindowTray(input)")) return s;
  const helper = built.match(/function installWindowTray\(input\) \{[\s\S]*?\n\}/)?.[0];
  const integration = built.match(
    /\t\tif \(environment.platform === "win32" && iconOption.icon\)[\s\S]*?(?=\t\tif \(environment.platform === "darwin"\))/,
  )?.[0];
  if (!helper || !integration) throw new Error("Compiled tray helper/integration missing");
  for (const binding of [
    'let electron = require("electron")',
    'let effect_Effect = require("effect/Effect")',
    'let effect_Option = require("effect/Option")',
  ]) {
    if (!s.includes(binding)) throw new Error(`Unsupported desktop bindings: ${binding}`);
  }
  s = schema(s);
  const anchor = '\t\twindow.on("close", () => {\n\t\t\trunFork(flushBoundsPersist);\n\t\t});\n';
  // Function declarations are hoisted; appending keeps the directive prologue intact.
  return `${once(s, anchor, anchor + integration)}\n${helper}\n`;
}
function patchWeb(s) {
  if (s.includes("id:`close-to-tray`")) return s;
  s = once(
    s,
    "{id:`quit-confirmation`,title:`Hold to quit`,to:`/settings/general`,desktopOnly:!0}",
    "{id:`close-to-tray`,title:`Desktop: keep running in system tray when closed`,to:`/settings/general`,desktopOnly:!0},{id:`quit-confirmation`,title:`Hold to quit`,to:`/settings/general`,desktopOnly:!0}",
  );
  s = once(
    s,
    "confirmQuit:ts.confirmQuit,textGenerationModelSelection:",
    "confirmQuit:ts.confirmQuit,closeToTray:ts.closeToTray,textGenerationModelSelection:",
  );
  s = once(
    s,
    "(Zp||e.desktopOnly!==!0)&&",
    "(Zp||e.desktopOnly!==!0)&&(e.id!==`close-to-tray`||/Win/i.test(navigator.platform))&&",
  );
  s = once(
    s,
    "e[210]!==t.confirmQuit||e[211]!==n?",
    'e[210]!==t.confirmQuit+"|"+t.closeToTray||e[211]!==n?',
  );
  s = once(
    s,
    "pt=Zp?(0,Z.jsx)(Cj,{...Dj(`quit-confirmation`)",
    'pt=[Zp&&/Win/i.test(navigator.platform)?(0,Z.jsx)(Cj,{key:"tray",...Dj(`close-to-tray`),description:"Keep sessions and remote connections running when you close the window. Use Quit T3 in the tray menu to exit completely.",resetAction:t.closeToTray===ts.closeToTray?null:(0,Z.jsx)(wj,{label:"close to tray",onClick:()=>n({closeToTray:ts.closeToTray})}),control:(0,Z.jsx)(EB,{checked:t.closeToTray,onCheckedChange:e=>n({closeToTray:!!e}),"aria-label":"Keep running in system tray when closed"})}):null,Zp?(0,Z.jsx)(Cj,{key:"quit",...Dj(`quit-confirmation`)',
  );
  s = once(
    s,
    ":null,e[210]=t.confirmQuit,e[211]=n,e[212]=pt)",
    ':null],e[210]=t.confirmQuit+"|"+t.closeToTray,e[211]=n,e[212]=pt)',
  );
  return s;
}
function stageArchive(asar, Pickle, input, output, transform) {
  const raw = asar.getRawHeader(input),
    original = fs.readFileSync(input);
  const dataStart = 8 + raw.headerSize;
  const files = [];
  function visit(node, prefix = "") {
    for (const [name, child] of Object.entries(node.files || {})) {
      const entry = prefix ? `${prefix}/${name}` : name;
      if (child.files) visit(child, entry);
      else if (!child.unpacked && typeof child.offset === "string")
        files.push({ entry, node: child });
    }
  }
  visit(raw.header);
  const replacements = new Map();
  for (const { entry } of files) {
    if (!/\.(?:cjs|mjs|js)$/.test(entry) || entry.includes("node_modules/")) continue;
    const before = asar.extractFile(input, entry.split("/").join(path.sep));
    const text = before.toString("utf8");
    const transformed = transform(entry, text);
    if (text !== transformed) replacements.set(entry, Buffer.from(transformed));
  }
  for (const [entry, bytes] of [...replacements]) {
    for (const [suffix, compress] of [
      [".gz", zlib.gzipSync],
      [".br", zlib.brotliCompressSync],
    ]) {
      if (files.some((f) => f.entry === entry + suffix))
        replacements.set(entry + suffix, compress(bytes));
    }
  }
  const chunks = [];
  let offset = 0;
  for (const { entry, node } of files.sort(
    (a, b) => Number(a.node.offset) - Number(b.node.offset),
  )) {
    const bytes =
      replacements.get(entry) ??
      original.subarray(
        dataStart + Number(node.offset),
        dataStart + Number(node.offset) + node.size,
      );
    node.offset = String(offset);
    node.size = bytes.length;
    if (replacements.has(entry)) {
      const blockSize = node.integrity?.blockSize || 4194304;
      const blocks = [];
      for (let i = 0; i < bytes.length; i += blockSize)
        blocks.push(hash(bytes.subarray(i, i + blockSize)));
      node.integrity = { algorithm: "SHA256", hash: hash(bytes), blockSize, blocks };
    }
    chunks.push(bytes);
    offset += bytes.length;
  }
  const header = Pickle.createEmpty();
  header.writeString(JSON.stringify(raw.header));
  const size = Pickle.createEmpty();
  size.writeUInt32(header.toBuffer().length);
  fs.writeFileSync(output, Buffer.concat([size.toBuffer(), header.toBuffer(), ...chunks]));
  asar.uncache(output);
  for (const { entry } of files) {
    const nativeEntry = entry.split("/").join(path.sep);
    if (
      !asar
        .extractFile(output, nativeEntry)
        .equals(replacements.get(entry) ?? asar.extractFile(input, nativeEntry))
    )
      throw new Error(`Verification failed: ${entry}`);
  }
  return [...replacements.keys()];
}
if (require.main === module) {
  const [resources, out, builtMain, asarModule] = process.argv.slice(2);
  if (!resources || !out || !builtMain || !asarModule)
    throw new Error("Usage: resources output-directory compiled-main.cjs asar-module");
  if (fs.existsSync(out)) throw new Error("Output directory must be new");
  fs.mkdirSync(out, { recursive: true });
  const asar = require(asarModule),
    { Pickle } = require(path.join(asarModule, "lib/pickle"));
  const built = fs.readFileSync(builtMain, "utf8");
  const result = {};
  for (const name of ["app", "server"]) {
    const input = path.join(resources, `${name}.asar`),
      output = path.join(out, `${name}.asar`);
    const entries = stageArchive(asar, Pickle, input, output, (entry, s) => {
      if (name === "app" && entry.endsWith("/dist-electron/main.cjs"))
        return patchDesktop(s, built);
      if (name === "server") {
        if (s.includes("id:`quit-confirmation`")) return patchWeb(s);
        if (s.includes("confirmQuit:")) return schema(s);
      }
      return s;
    });
    if (!entries.length) throw new Error(`No ${name} changes staged`);
    result[name] = {
      before: hash(fs.readFileSync(input)),
      after: hash(fs.readFileSync(output)),
      entries,
    };
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
module.exports = { patchDesktop, patchWeb, schema, stageArchive };
