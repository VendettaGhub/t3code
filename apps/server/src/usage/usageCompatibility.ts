import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type UsageSummary,
} from "@t3tools/contracts";

/**
 * Keeps the usage RPC decodable by v4 mobile clients while allowing v5
 * clients to opt in to the additive Grok provider.
 *
 * The request capability was introduced with v5, so an absent value means the
 * caller only knows the v4 Claude/Codex schema. Current clients explicitly
 * send v5. Negotiating at the final response boundary also guarantees that a
 * Grok source with no in-window records cannot leak through and fail decoding.
 */
export function negotiateUsageSummary(
  summary: UsageSummary,
  requestedVersion: number | undefined,
): UsageSummary {
  if (requestedVersion !== undefined && requestedVersion >= USAGE_CONTRACT_VERSION) {
    return summary;
  }

  return {
    ...summary,
    contractVersion: USAGE_MERGE_COMPATIBLE_SINCE,
    buckets: summary.buckets.filter((bucket) => bucket.provider !== "grok"),
    sources: summary.sources.filter((source) => source.fingerprint.provider !== "grok"),
  };
}
