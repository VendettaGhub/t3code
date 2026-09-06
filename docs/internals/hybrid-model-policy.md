# Hybrid model policy (fork only)

The v0.0.38 implementation overlays Claude's resolved catalog in source.
It is opt-in per provider environment: `CLAUDE_BACKEND=hybrid` and a configured
`ANTHROPIC_BASE_URL` are required. Normal Claude instances retain native models.
Catalog refreshes reapply the overlay; no generated bundle anchors are involved.

`HybridModelPolicy` owns the six supported picker models. Sol and Luna use
Claude carrier slots but are custom current models, not legacy Claude entries.
Astra has a separate standard/priority service-tier selection. Qwen stays fixed
at 131,072 context tokens with compaction at 95,000.

The other hybrid defaults are 272,000 context / 240,000 compaction. The 900k
option compacts at 850k; eligible 1M options compact at 900k. These are local
client limits, not pricing promises or proof of upstream capacity. The explicit
hybrid policy overrides the global Claude compaction setting, as the prior
deployment did; native instances still use their configured setting.

The four Claude carrier slots retain the existing `[1m][effort=...]` wire format
even at the lower local limit. It enables the SDK's context capacity while the
per-process policy controls compaction. Do not infer billing thresholds from
that suffix. Qwen and Astra never receive this suffix. The router normalizes
dated aliases for only the two supported Sol/Luna carrier families.

`ProviderCommandReactor` restarts and resumes Claude whenever the selected model
or its options change. This recreates the SDK query with fresh environment and
compaction settings; updating only `setModel` inside an already-bound adapter
would not update process environment. No shared process environment is mutated.

Subagent display metadata prioritizes observed runtime model, then explicit
launch input, then project/user agent frontmatter, then parent defaults. User
agent files are read from the same instance-specific Claude config directory as
the runtime. Later assistant snapshots use the same model normalization.

The permission callback remains present in full-access mode for user questions
and plan exit. The older omission workaround is not part of this migration.

Verification covers catalog/policy resolution, actual SDK query options,
orchestration restart/resume, routing and subagent metadata. A source test does
not prove the running desktop, WSL runtime, or phone received a new build.
