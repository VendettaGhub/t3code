const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_SCHEMA = "t3-update-artifact/v1";
const VERIFICATION_REPORT_SCHEMA = "t3-update-artifact-verification/v1";

function fail(message) {
  throw new Error(message);
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${name} is required.`);
  }
  return value.trim();
}

function requireCommit(value, name) {
  const commit = requireString(value, name);
  if (!/^[0-9a-f]{40}$/iu.test(commit)) fail(`${name} must be a full 40-character commit ID.`);
  return commit.toLowerCase();
}

function requireVersion(value) {
  const version = requireString(value, "version");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    fail(`Invalid version: ${version}`);
  }
  return version;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function normalizedPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function realRoot(rootInput) {
  const root = path.resolve(requireString(rootInput, "artifact root"));
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`Artifact root must be a real directory: ${root}`);
  }
  return fs.realpathSync(root);
}

function pathInside(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath)
  ) {
    fail(`Artifact path is not relative: ${String(relativePath)}`);
  }
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    fail(`Artifact path escapes the artifact root: ${relativePath}`);
  }
  return candidate;
}

function relativeToRoot(root, filePath) {
  const relative = path.relative(root, filePath);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    fail(`Artifact path escapes the artifact root: ${filePath}`);
  }
  return normalizedPath(relative);
}

function walkFiles(root, current = root, output = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink())
      fail(`Symlinks are not allowed in the staged artifact: ${fullPath}`);
    if (entry.isDirectory()) {
      walkFiles(root, fullPath, output);
    } else if (entry.isFile()) {
      const relativePath = relativeToRoot(root, fullPath);
      output.push({
        path: relativePath,
        length: fs.statSync(fullPath).size,
        sha256: sha256(fullPath),
      });
    } else {
      fail(`Unsupported filesystem entry in the staged artifact: ${fullPath}`);
    }
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function assertFile(root, relativePath, label) {
  const filePath = pathInside(root, relativePath);
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    fail(`${label} is missing, not a regular file, or empty: ${relativePath}`);
  }
  return filePath;
}

function assertDirectory(root, relativePath, label) {
  const directoryPath = pathInside(root, relativePath);
  const stat = fs.lstatSync(directoryPath, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} is missing or not a real directory: ${relativePath}`);
  }
  const files = walkFiles(root, directoryPath);
  if (!files.some((entry) => entry.path.startsWith(`${normalizedPath(relativePath)}/`))) {
    fail(`${label} contains no regular files: ${relativePath}`);
  }
  return directoryPath;
}

function readSuccessfulReport(reportPathInput) {
  const reportPath = path.resolve(requireString(reportPathInput, "verification report"));
  const stat = fs.lstatSync(reportPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink())
    fail(`Verification report is not a regular file: ${reportPath}`);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    fail(`Verification report is not valid JSON: ${error.message}`);
  }
  if (report?.schema !== VERIFICATION_REPORT_SCHEMA)
    fail(`Verification report schema must be ${VERIFICATION_REPORT_SCHEMA}.`);
  if (report.status !== "passed") fail("Verification report status must be passed.");
  if (report.tests?.status !== "passed") fail("Verification report tests.status must be passed.");
  if (report.build?.status !== "passed") fail("Verification report build.status must be passed.");
  if (typeof report.tests?.command !== "string" || report.tests.command.trim().length === 0) {
    fail("Verification report tests.command must be a non-empty string.");
  }
  if (typeof report.build?.command !== "string" || report.build.command.trim().length === 0) {
    fail("Verification report build.command must be a non-empty string.");
  }
  return {
    status: "passed",
    fileName: path.basename(reportPath),
    length: stat.size,
    sha256: sha256(reportPath),
  };
}

function packagedExecutableName(version) {
  return /-nightly\.\d{8}\.\d+$/u.test(version) ? "T3 Code (Nightly).exe" : "T3 Code (Alpha).exe";
}

function requiredArtifactPaths(root, version) {
  const resources = "win-unpacked/resources";
  const installerNames = fs
    .readdirSync(root)
    .filter((name) => /^T3-Code-[^/\\]+\.exe$/iu.test(name));
  if (installerNames.length !== 1) {
    fail(`Expected exactly one direct T3 installer executable, found ${installerNames.length}.`);
  }
  if (!installerNames[0].startsWith(`T3-Code-${version}-`)) {
    fail(`Installer version does not match ${version}: ${installerNames[0]}`);
  }
  const required = [
    { role: "installer", path: installerNames[0] },
    { role: "desktop-executable", path: `win-unpacked/${packagedExecutableName(version)}` },
    { role: "app", path: `${resources}/app.asar` },
    { role: "server", path: `${resources}/server.asar` },
    { role: "wsl-runtime", path: `${resources}/wsl-runtime.tar.gz` },
    { role: "wsl-runtime-sha256", path: `${resources}/wsl-runtime.tar.gz.sha256` },
    { role: "resource-monitor", path: `${resources}/resource-monitor/t3-resource-monitor.exe` },
  ];
  assertDirectory(root, `${resources}/app.asar.unpacked`, "app.asar.unpacked");
  assertDirectory(root, `${resources}/server.asar.unpacked`, "server.asar.unpacked");
  required.push(
    { role: "app-unpacked", path: `${resources}/app.asar.unpacked` },
    { role: "server-unpacked", path: `${resources}/server.asar.unpacked` },
  );
  for (const entry of required.filter((entry) => !entry.role.endsWith("-unpacked"))) {
    assertFile(root, entry.path, entry.role);
  }
  const runtimePath = pathInside(root, `${resources}/wsl-runtime.tar.gz`);
  const recordedHash = fs
    .readFileSync(pathInside(root, `${resources}/wsl-runtime.tar.gz.sha256`), "utf8")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(recordedHash)) fail("WSL runtime sidecar is not a SHA-256 digest.");
  const actualHash = sha256(runtimePath);
  if (recordedHash !== actualHash)
    fail(`WSL runtime sidecar mismatch: expected ${recordedHash}, got ${actualHash}.`);
  return required;
}

function roleFor(relativePath, required) {
  const requiredEntry = required.find((entry) => entry.path === relativePath);
  if (requiredEntry) return requiredEntry.role;
  if (relativePath.startsWith("win-unpacked/resources/app.asar.unpacked/")) return "app-unpacked";
  if (relativePath.startsWith("win-unpacked/resources/server.asar.unpacked/"))
    return "server-unpacked";
  return "other";
}

function ensureManifestPathOutsideRoot(root, outputPath) {
  const candidate = path.resolve(requireString(outputPath, "manifest output"));
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    fail("Manifest output must be outside the artifact root.");
  }
  return candidate;
}

function createManifest(options) {
  const root = realRoot(options.artifactRoot);
  const version = requireVersion(options.version);
  const outputPath = ensureManifestPathOutsideRoot(root, options.outputPath);
  const required = requiredArtifactPaths(root, version);
  const report = readSuccessfulReport(options.verificationReportPath);
  const files = walkFiles(root).map((entry) => ({ ...entry, role: roleFor(entry.path, required) }));
  const manifest = {
    schema: MANIFEST_SCHEMA,
    artifact: "windows-desktop-dist",
    version,
    source: {
      upstreamCommit: requireCommit(options.upstreamCommit, "upstream commit"),
      customCommit: requireCommit(options.customCommit, "custom commit"),
    },
    provenance: {
      nodeVersion: requireString(options.nodeVersion, "node version"),
      pnpmVersion: requireString(options.pnpmVersion, "pnpm version"),
      toolchain: requireString(options.toolchain, "toolchain"),
    },
    verificationReport: report,
    files,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function verifyManifest(options) {
  const root = realRoot(options.artifactRoot);
  const manifestPath = path.resolve(requireString(options.manifestPath, "manifest"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest?.schema !== MANIFEST_SCHEMA) fail(`Manifest schema must be ${MANIFEST_SCHEMA}.`);
  requireVersion(manifest.version);
  requireCommit(manifest.source?.upstreamCommit, "manifest upstream commit");
  requireCommit(manifest.source?.customCommit, "manifest custom commit");
  requireString(manifest.provenance?.nodeVersion, "manifest node version");
  requireString(manifest.provenance?.pnpmVersion, "manifest pnpm version");
  requireString(manifest.provenance?.toolchain, "manifest toolchain");
  const report = readSuccessfulReport(options.verificationReportPath);
  if (
    report.fileName !== manifest.verificationReport?.fileName ||
    report.length !== manifest.verificationReport?.length ||
    report.sha256 !== manifest.verificationReport?.sha256
  ) {
    fail("Verification report does not match the manifest.");
  }
  const required = requiredArtifactPaths(root, manifest.version);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0)
    fail("Manifest file inventory is empty.");
  const expected = new Map();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || expected.has(entry.path))
      fail("Manifest file inventory is invalid or duplicated.");
    if (entry.path !== normalizedPath(entry.path))
      fail(`Manifest file path is not normalized: ${entry.path}`);
    if (!/^\d+$/u.test(String(entry.length)) || !/^[0-9a-f]{64}$/u.test(entry.sha256))
      fail(`Manifest file entry is invalid: ${entry.path}`);
    pathInside(root, entry.path);
    expected.set(entry.path, entry);
  }
  const current = walkFiles(root);
  if (current.length !== expected.size || current.some((entry) => !expected.has(entry.path))) {
    fail("Staged artifact file inventory differs from the manifest.");
  }
  for (const entry of current) {
    const recorded = expected.get(entry.path);
    if (recorded.length !== entry.length) fail(`Artifact length mismatch: ${entry.path}`);
    if (recorded.sha256 !== entry.sha256) fail(`Artifact hash mismatch: ${entry.path}`);
  }
  for (const requiredEntry of required) {
    if (requiredEntry.role.endsWith("-unpacked")) {
      const prefix = `${normalizedPath(requiredEntry.path)}/`;
      if (
        !manifest.files.some(
          (entry) => entry.role === requiredEntry.role && entry.path.startsWith(prefix),
        )
      ) {
        fail(`Manifest is missing required role: ${requiredEntry.role}`);
      }
    } else if (
      !manifest.files.some(
        (entry) => entry.path === requiredEntry.path && entry.role === requiredEntry.role,
      )
    ) {
      fail(`Manifest is missing required role: ${requiredEntry.role}`);
    }
  }
  return { status: "verified", version: manifest.version, fileCount: current.length };
}

function parseArgs(argv) {
  const command = argv.shift();
  if (command !== "create" && command !== "check") fail("Usage: create|check [options]");
  const options = {};
  const allowed =
    command === "create"
      ? new Set([
          "root",
          "output",
          "version",
          "upstreamcommit",
          "customcommit",
          "verificationreport",
          "nodeversion",
          "pnpmversion",
          "toolchain",
        ])
      : new Set(["root", "manifest", "verificationreport"]);
  while (argv.length > 0) {
    const flag = argv.shift();
    if (!flag.startsWith("--") || argv.length === 0) fail(`Invalid argument: ${flag}`);
    const key = flag.slice(2).replaceAll("-", "");
    if (!allowed.has(key)) fail(`Unsupported argument for ${command}: ${flag}`);
    options[key] = argv.shift();
  }
  return { command, options };
}

function runCli(argv) {
  const { command, options } = parseArgs([...argv]);
  if (command === "create") {
    const manifest = createManifest({
      artifactRoot: options.root,
      outputPath: options.output,
      version: options.version,
      upstreamCommit: options.upstreamcommit,
      customCommit: options.customcommit,
      verificationReportPath: options.verificationreport,
      nodeVersion: options.nodeversion,
      pnpmVersion: options.pnpmversion,
      toolchain: options.toolchain,
    });
    console.log(
      JSON.stringify({
        status: "created",
        version: manifest.version,
        fileCount: manifest.files.length,
      }),
    );
  } else {
    console.log(
      JSON.stringify(
        verifyManifest({
          artifactRoot: options.root,
          manifestPath: options.manifest,
          verificationReportPath: options.verificationreport,
        }),
      ),
    );
  }
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  MANIFEST_SCHEMA,
  VERIFICATION_REPORT_SCHEMA,
  createManifest,
  verifyManifest,
};
