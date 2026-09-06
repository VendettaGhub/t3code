# Custom hybrid desktop updates

This runbook describes a reproducible, **staged-only** update of the fork's
custom hybrid setup onto a new upstream desktop release. It does not install an
installer, replace a live ASAR/runtime, start a server, or restart a desktop
process. Those are separate, explicitly authorized operations.

The examples use portable placeholders. Replace `<repo-root>`, `<update-worktree>`,
`<snapshot-dir>`, `<prep-root>`, `<temp-root>`, `<artifact-output>`, and
`<verification-report.json>` with paths appropriate to the current machine.
Never put credentials, runtime databases, private endpoints, or machine-specific
paths in this document or in a commit.

## 1. Preserve the original fork and choose the integration strategy

Start from a cleanly identified snapshot of the original fork. Do not mutate the
original checkout while preparing the update:

```powershell
$original = "<repo-root>"
$snapshot = "<snapshot-dir>"
$base = (git -C $original rev-parse HEAD).Trim()
New-Item -ItemType Directory -Force $snapshot | Out-Null
$base | Set-Content (Join-Path $snapshot "original-commit.txt")
git -C $original status --short | Set-Content (Join-Path $snapshot "original-status.txt")
git -C $original worktree add -b custom/hybrid-update-v0.0.38 `
  "<update-worktree>" $base
```

The commit and status files are an audit pointer, not a claim that the original
working tree was clean. If the original contains intentional uncommitted work,
record that work outside the repository (excluding secrets and live runtime
state) before deciding which parts belong in the update.

Use a **merge** for a stable fork branch when local custom commits already have
consumers or are useful evidence. It preserves both histories and makes the
upstream integration point explicit:

```powershell
git -C "<update-worktree>" remote add upstream https://github.com/pingdotgg/t3code.git # once
git -C "<update-worktree>" fetch --tags upstream
git -C "<update-worktree>" merge --no-ff <upstream-commit-40>
```

Use a **rebase** only when the branch is private and rewriting local commit IDs
is acceptable. Rebase gives a linear history but invalidates commit references
already used in reports or reviews; it is not the default for a stable fork.
Neither strategy authorizes a push.

Before resolving conflicts, inventory additions, changes, and removals. In
particular, inspect provider/model code, build scripts, patches, and native
inputs rather than assuming the previous release layout still exists:

```powershell
git -C "<update-worktree>" diff --name-status <base-commit-40> <upstream-commit-40>
git -C "<update-worktree>" diff --stat <base-commit-40> <upstream-commit-40>
git -C "<update-worktree>" diff --diff-filter=D --name-status <base-commit-40> <upstream-commit-40>
git -C "<update-worktree>" log --oneline <upstream-commit-40>..HEAD
git -C "<update-worktree>" diff <upstream-commit-40>..HEAD -- patches scripts/custom-hybrid
```

Record each removed or renamed path and the replacement decision in the update
review. Do not silently carry a patch forward when its source anchor was
removed.

## 2. Keep the source, model, runtime, and native layers separate

Treat these as different inputs with different verification rules:

| Layer             | Update rule                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source            | Apply only to the selected upstream commit. Check a patch with `git apply --check` before applying it; record its base/target commit and digest.                                                                                                             |
| Model catalog     | v0.0.38 uses its source-native model catalog. Update the catalog/manifests and focused source tests when needed. Do **not** run the old `t3-hybrid-picker-patch.cjs` bundle patch against the v0.0.38 bundle; old v0.0.37 fixtures are not v0.0.38 evidence. |
| Router/runtime    | `scripts/custom-hybrid/claude-hybrid-router.cjs` remains runtime configuration. Tests must use fake endpoints or injected values; credentials and private hosts stay outside the repository.                                                                 |
| Native inputs     | Pin target-release binaries by release, architecture, and digest. Do not copy an installed older T3 binary or an active WSL runtime.                                                                                                                         |
| Packaged artifact | Build into an isolated stage and produce/check the hash manifest with `t3-update-artifact.cjs`.                                                                                                                                                              |

For the v0.0.38 model change, inspect the source catalog/manifests in the
selected tag and make the smallest source-level change there. A successful
bundle patch test for an older release does not authorize a v0.0.38 patch. In
particular, do not reapply the obsolete picker bypass: its old `canUseTool`
omission breaks upstream `AskUserQuestion` and `ExitPlanMode` callbacks. The
candidate is not install-ready while an external launcher still unconditionally
invokes that old patcher; adapting that launcher is a separate readiness-gate
change and is intentionally outside this staged update.

## 3. Pin the build toolchain and native release inputs

The repository declares Node `^24.13.1` and `pnpm@11.10.0`. Use those exact
versions in the isolated worktree and verify them before dependency resolution:

```powershell
node --version       # expected: v24.13.1
pnpm --version       # expected: 11.10.0
pnpm install --frozen-lockfile
```

The dependency install above is a build prerequisite in the isolated worktree;
it is not an application installation. This runbook does not install or update
the live desktop.

For the v0.0.38 Windows x64 package, the release inputs must be re-verified
against the official [v0.0.38 release](https://github.com/pingdotgg/t3code/releases/tag/v0.0.38)
and the external provenance record. The pinned values are:

| Input                       | Release/architecture                                  | SHA-256                                                            |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Windows installer           | v0.0.38, x64                                          | `93df0df7e0166f70f42f949aa462425899ecd3e3f9581523209b18874f62ead0` |
| Resource monitor executable | v0.0.38, `x86_64-pc-windows-msvc`                     | `9af2df779e6e0a20c231c869892ceb791d44e950d0a3860eb23b2f0e1f7cbe4`  |
| WSL `pty.node`              | v0.0.38 server payload, `linux-x64`, node-pty `1.1.0` | `377d992b55a37f7d90588ec0a8bd9363b590631a66cdfa8f97ab474db064f15e` |
| WSL runtime archive         | v0.0.38, `linux-x64`                                  | `5c7deb370aaa6f1bfb3ff286f10a05ce6f815d0f8f2e376869a4cb87217f867e` |

The source release identity is tag `v0.0.38`, commit
`c0995d2eaf8ec787b3318ed1169ae266ed1529f8`. These values are checks, not a
license to use a stale installed file. Keep the release API response, update
asset metadata, extraction manifest, and `executedInstaller: false` provenance
outside the repository. Extract the official installer with a trusted archive
tool; never execute it as part of preparation.

### Resource monitor override

The builder supports `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true`, but this is
not an arbitrary external-file override. It reuses the target-specific binary
already at:

```text
native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe
```

When the flag is unset/false, the builder runs the locked Cargo release build.
When it is true, an authorized packaging step must first place a verified
v0.0.38 target binary at the exact path above and record its digest. The current
builder has no flag that accepts a resource-monitor path directly. If Cargo is
unavailable, use a separately prepared, release-pinned prebuilt input; do not
silently reuse an installed old binary. The final artifact manifest below still
hashes the staged executable.

## 4. Run focused checks, then build the retained stage

Run the tests for changed custom tools and the affected packages. These commands
are intentionally scoped; the repository instructions reserve full recursive
checks for CI:

```powershell
node --test scripts/custom-hybrid/*.test.cjs
pnpm exec vp run --filter @t3tools/desktop typecheck
pnpm exec vp run --filter t3 typecheck
pnpm exec vp run --filter @t3tools/desktop test
pnpm exec vp run --filter t3 test
```

Build the desktop/server inputs before packaging. The root script is exactly:

```powershell
pnpm run build:desktop
```

The artifact builder accepts `--platform win`, `--target nsis`, `--arch x64`,
`--build-version`, `--output-dir`, `--skip-build`, `--keep-stage`, `--signed`,
`--verbose`, `--mock-updates`, `--mock-update-server-port`, and `--wsl-prebuild`.
For a reproducible Windows x64 staging run, use a dedicated temporary directory
so the retained stage can be identified without guessing among old stages:

```powershell
New-Item -ItemType Directory -Force "<temp-root>" | Out-Null
$env:TEMP = (Resolve-Path "<temp-root>").Path
$env:TMP = $env:TEMP
pnpm run dist:desktop:artifact -- `
  --platform win --target nsis --arch x64 `
  --build-version 0.0.38 `
  --output-dir "<artifact-output>" `
  --keep-stage --skip-build `
  --wsl-prebuild "<prep-root>/native-inputs/wsl-prebuild/linux-x64/pty.node"
```

Use `--skip-build` only because `pnpm run build:desktop` already completed for
the same source checkout. `--keep-stage` leaves a directory named
`t3code-desktop-win-stage-*`; the complete manifest root is its `app/dist`, not
the top-level installer-copy directory:

```powershell
$stage = Get-ChildItem $env:TEMP -Directory -Filter "t3code-desktop-win-stage-*" |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $stage) { throw "The retained desktop stage was not found." }
$stageDist = Join-Path $stage.FullName "app\dist"
if (-not (Test-Path -LiteralPath $stageDist -PathType Container)) {
  throw "The retained stage does not contain app\dist."
}
```

Confirm that `$stageDist` is the stage from this run and contains exactly the
expected Windows payload before creating a manifest. Do not select a stage from
another build.

## 5. Produce and verify the artifact manifest

Create a verification report only after the commands in the preceding section
actually pass. The report schema is deliberately small:

```json
{
  "schema": "t3-update-artifact-verification/v1",
  "status": "passed",
  "tests": { "status": "passed", "command": "<recorded focused test commands>" },
  "build": { "status": "passed", "command": "<recorded build and package commands>" }
}
```

Do not write `passed` for a skipped, failed, or unrun test/build. The manifest
CLI does not run tests; it only consumes this report and hashes the staged files.
Both commit arguments must be full 40-character IDs:

```powershell
node scripts/custom-hybrid/t3-update-artifact.cjs create `
  --root $stageDist `
  --output "<artifact-output>/t3-update-artifact.json" `
  --version 0.0.38 `
  --upstream-commit <upstream-commit-40> `
  --custom-commit <custom-commit-40> `
  --verification-report "<verification-report.json>" `
  --node-version v24.13.1 `
  --pnpm-version 11.10.0 `
  --toolchain windows-x64-node24

node scripts/custom-hybrid/t3-update-artifact.cjs check `
  --root $stageDist `
  --manifest "<artifact-output>/t3-update-artifact.json" `
  --verification-report "<verification-report.json>"
```

The validator fails closed when the installer, `app.asar`, `server.asar`, WSL
archive or sidecar, resource monitor, or unpacked native/resource directories
are missing. It rejects symlinks, root escapes, extra/missing files, tampered
hashes, and a mismatched WSL SHA-256 sidecar. Keep the manifest and report with
the staged artifact output, not in the live installation.

## 6. Handoff boundary

This workflow ends at a verified staged artifact and its provenance. Do not run
an installer, invoke a live install helper, overwrite ASAR files, replace a WSL
runtime, start a server, or restart the desktop. A later operational change
needs separate authorization, a backup/preflight plan, and a fresh post-change
status check. Until then, the original fork and its runtime remain untouched.
