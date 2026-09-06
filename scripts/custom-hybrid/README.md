# Custom hybrid tooling

This directory preserves the fork-only parts of the local Claude/Codex hybrid setup. It is not intended for an upstream pull request.

For v0.0.38 and later, model policy and subagent metadata are implemented in
server source, not by patching compiled JavaScript. Follow the
[update runbook](../../docs/operations/custom-hybrid-updates.md) and
[native policy notes](../../docs/internals/hybrid-model-policy.md).
The provider environment must explicitly set `CLAUDE_BACKEND=hybrid` and
`ANTHROPIC_BASE_URL` to the configured hybrid router. Other Claude instances keep
their native catalog and model IDs. No launcher or router is started automatically.

## Contents

- `t3-hybrid-picker-patch.cjs`: legacy v0.0.37 bundle patcher retained for rollback/reference only. Do not run it on a v0.0.38 candidate; its fixtures are not verification of the native implementation.
- `claude-hybrid-router.cjs`: request router and fallback chain: Claude → Sol → Luna → Qwen.
- Matching Node test files for both tools.
- `t3-tray-stage.cjs`: stages the Windows close-to-tray setting and native tray without replacing unrelated installed patches. Run with the installed resources directory, a new output directory, the compiled desktop `main.cjs`, and the `@electron/asar` module path. Bundle anchors are deliberately version-specific; unknown builds fail closed. Keep the original `.asar.unpacked` directories beside the installed archives. The manifest contains before/after hashes; install only after tests, back up both archives, and restart T3. This tool never writes to the live installation itself.

Hybrid Claude/Codex models default to a 272k context window with 240k compaction.
The optional 900k selection compacts at 850k; Qwen retains its separate limits.
Qwen generation (including fallback) requires a successful upstream token count.
The router reserves 1,024 tokens within its 131,072-token context and caps output
at the smaller of the remaining budget and 32,768 tokens (default 8,192 when omitted).
This is a local safety policy, not a claim about a separate server output limit.
Exhausted context returns an actionable error; conversation/tool data is never
silently truncated. A failed count returns 503 without sending generation.
These are client settings, not a guarantee of upstream capacity or subscription pricing.
Astra is routed explicitly and does not silently fall back to another model.
The native implementation retains the permission callback in bypass mode so
AskUserQuestion and ExitPlanMode remain functional. The legacy callback-omission
workaround is deliberately not carried forward. The separate Claude-plugin
environment-export repair has its own update lifecycle.

Bundle anchors are version-specific. Validate a candidate before installation; source tests
do not prove that a running Windows or WSL installation has received the patch. WSL's
shipped runtime archive and its integrity metadata must be handled by the host installer,
not merely a disposable extracted runtime cache.

## Configuration

No credentials or private hosts are stored in this repository. Configure them at runtime:

- `CLI_PROXY_URL`: OpenAI/Codex-compatible proxy URL.
- `CLI_PROXY_KEY` or `CLI_PROXY_CONFIG`: proxy authentication source.
- `QWEN_UPSTREAM`: Qwen Anthropic-compatible endpoint reachable from the host, for example `http://<vpn-host>:8010`.
- `ANTHROPIC_UPSTREAM`: optional Claude upstream override.
- `HYBRID_ROUTER_AUDIT_LOG`: optional local audit-log path.

The machine-specific Windows/WSL launcher, service paths, credentials, installers, ASAR files, and runtime logs are deliberately excluded.

## Tests

```powershell
node --test scripts/custom-hybrid/t3-hybrid-picker-patch.test.cjs
node --test scripts/custom-hybrid/claude-hybrid-router.test.cjs
node --test scripts/custom-hybrid/qwen-budget.test.cjs
```
