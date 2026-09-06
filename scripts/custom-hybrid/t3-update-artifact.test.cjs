const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const tool = require("./t3-update-artifact.cjs");

const UPSTREAM = "0123456789abcdef0123456789abcdef01234567";
const CUSTOM = "89abcdef0123456789abcdef0123456789abcdef";

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createFixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-update-artifact-"));
  const artifactRoot = path.join(temp, "dist");
  const resources = path.join(artifactRoot, "win-unpacked", "resources");
  const runtime = path.join(resources, "wsl-runtime.tar.gz");
  writeFile(path.join(artifactRoot, "T3-Code-0.0.38-x64.exe"), "installer");
  writeFile(path.join(artifactRoot, "win-unpacked", "T3 Code (Alpha).exe"), "desktop");
  writeFile(path.join(resources, "app.asar"), "app");
  writeFile(path.join(resources, "server.asar"), "server");
  writeFile(runtime, "runtime");
  writeFile(`${runtime}.sha256`, `${sha256(runtime)}\n`);
  writeFile(path.join(resources, "resource-monitor", "t3-resource-monitor.exe"), "monitor");
  writeFile(path.join(resources, "app.asar.unpacked", "node_modules", "native.node"), "app-native");
  writeFile(
    path.join(resources, "server.asar.unpacked", "node_modules", "native.node"),
    "server-native",
  );

  const reportPath = path.join(temp, "verification-report.json");
  writeFile(
    reportPath,
    `${JSON.stringify(
      {
        schema: tool.VERIFICATION_REPORT_SCHEMA,
        status: "passed",
        tests: { status: "passed", command: "node --test focused" },
        build: { status: "passed", command: "desktop artifact build" },
      },
      null,
      2,
    )}\n`,
  );
  return { temp, artifactRoot, reportPath };
}

function createOptions(fixture, outputPath) {
  return {
    artifactRoot: fixture.artifactRoot,
    outputPath,
    version: "0.0.38",
    upstreamCommit: UPSTREAM,
    customCommit: CUSTOM,
    verificationReportPath: fixture.reportPath,
    nodeVersion: "v24.13.1",
    pnpmVersion: "11.10.0",
    toolchain: "windows-x64-node24",
  };
}

test("creates and verifies a complete staged desktop artifact manifest", () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.temp, "manifest.json");
  const manifest = tool.createManifest(createOptions(fixture, manifestPath));

  assert.equal(manifest.schema, tool.MANIFEST_SCHEMA);
  assert.equal(manifest.version, "0.0.38");
  assert.deepEqual(manifest.source, { upstreamCommit: UPSTREAM, customCommit: CUSTOM });
  assert.deepEqual(manifest.provenance, {
    nodeVersion: "v24.13.1",
    pnpmVersion: "11.10.0",
    toolchain: "windows-x64-node24",
  });
  assert.equal(manifest.verificationReport.status, "passed");
  assert.ok(manifest.files.some((entry) => entry.role === "installer"));
  assert.ok(manifest.files.some((entry) => entry.role === "server-unpacked"));
  assert.ok(manifest.files.some((entry) => entry.role === "resource-monitor"));
  assert.ok(manifest.files.every((entry) => entry.path === entry.path.replaceAll("\\", "/")));
  assert.equal(
    tool.verifyManifest({
      artifactRoot: fixture.artifactRoot,
      manifestPath,
      verificationReportPath: fixture.reportPath,
    }).status,
    "verified",
  );
});

test("fails closed when a staged file is missing or tampered", () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.temp, "manifest.json");
  tool.createManifest(createOptions(fixture, manifestPath));
  fs.appendFileSync(
    path.join(fixture.artifactRoot, "win-unpacked", "resources", "server.asar"),
    "tampered",
  );
  assert.throws(
    () =>
      tool.verifyManifest({
        artifactRoot: fixture.artifactRoot,
        manifestPath,
        verificationReportPath: fixture.reportPath,
      }),
    /hash mismatch|length mismatch/i,
  );
});

test("requires the known T3 packaged desktop executable", () => {
  const fixture = createFixture();
  fs.rmSync(path.join(fixture.artifactRoot, "win-unpacked", "T3 Code (Alpha).exe"));
  assert.throws(
    () => tool.createManifest(createOptions(fixture, path.join(fixture.temp, "manifest.json"))),
    /desktop-executable is missing/i,
  );
});

test("requires a successful build and test report before creating a manifest", () => {
  const fixture = createFixture();
  fs.writeFileSync(
    fixture.reportPath,
    JSON.stringify({
      schema: tool.VERIFICATION_REPORT_SCHEMA,
      status: "passed",
      tests: { status: "failed" },
      build: { status: "passed" },
    }),
  );
  assert.throws(
    () => tool.createManifest(createOptions(fixture, path.join(fixture.temp, "manifest.json"))),
    /tests.*passed/i,
  );
});

test("requires non-empty test and build commands in a passed report", () => {
  const fixture = createFixture();
  fs.writeFileSync(
    fixture.reportPath,
    JSON.stringify({
      schema: tool.VERIFICATION_REPORT_SCHEMA,
      status: "passed",
      tests: { status: "passed" },
      build: { status: "passed" },
    }),
  );
  assert.throws(
    () => tool.createManifest(createOptions(fixture, path.join(fixture.temp, "manifest.json"))),
    /tests\.command must be a non-empty string/i,
  );

  fs.writeFileSync(
    fixture.reportPath,
    JSON.stringify({
      schema: tool.VERIFICATION_REPORT_SCHEMA,
      status: "passed",
      tests: { status: "passed", command: "node --test focused" },
      build: { status: "passed" },
    }),
  );
  assert.throws(
    () => tool.createManifest(createOptions(fixture, path.join(fixture.temp, "manifest.json"))),
    /build\.command must be a non-empty string/i,
  );
});

test("rejects an inventory path that escapes the staged root or an untracked file", () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.temp, "manifest.json");
  tool.createManifest(createOptions(fixture, manifestPath));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.files[0].path = "../outside.exe";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(
    () =>
      tool.verifyManifest({
        artifactRoot: fixture.artifactRoot,
        manifestPath,
        verificationReportPath: fixture.reportPath,
      }),
    /escapes|normalized/i,
  );

  tool.createManifest(createOptions(fixture, manifestPath));
  writeFile(path.join(fixture.artifactRoot, "unexpected.bin"), "unexpected");
  assert.throws(
    () =>
      tool.verifyManifest({
        artifactRoot: fixture.artifactRoot,
        manifestPath,
        verificationReportPath: fixture.reportPath,
      }),
    /inventory differs/i,
  );
});

test("CLI create and check use explicit paths", () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.temp, "manifest.json");
  const node = process.execPath;
  const script = path.join(__dirname, "t3-update-artifact.cjs");
  const create = require("node:child_process").spawnSync(
    node,
    [
      script,
      "create",
      "--root",
      fixture.artifactRoot,
      "--output",
      manifestPath,
      "--version",
      "0.0.38",
      "--upstream-commit",
      UPSTREAM,
      "--custom-commit",
      CUSTOM,
      "--verification-report",
      fixture.reportPath,
      "--node-version",
      "v24.13.1",
      "--pnpm-version",
      "11.10.0",
      "--toolchain",
      "windows-x64-node24",
    ],
    { encoding: "utf8" },
  );
  assert.equal(create.status, 0, create.stderr);
  const check = require("node:child_process").spawnSync(
    node,
    [
      script,
      "check",
      "--root",
      fixture.artifactRoot,
      "--manifest",
      manifestPath,
      "--verification-report",
      fixture.reportPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /verified/);
});
