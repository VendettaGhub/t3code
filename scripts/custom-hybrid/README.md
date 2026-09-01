# Custom hybrid tooling

This directory preserves the fork-only parts of the local Claude/Codex hybrid setup. It is not intended for an upstream pull request.

## Contents

- `t3-hybrid-picker-patch.cjs`: version-checked bundle patcher for Sol/Luna display aliases, model-specific effort/context settings, Qwen 131k/95k compaction, and subagent metadata.
- `claude-hybrid-router.cjs`: request router and fallback chain: Claude → Sol → Luna → Qwen.
- Matching Node test files for both tools.

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
```
