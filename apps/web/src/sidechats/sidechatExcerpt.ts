/**
 * Appending a sidechat excerpt to the MAIN thread's draft.
 *
 * The composer handle is not reachable from the right panel, so this goes
 * through `composerDraftStore.addReviewComment`, the same caret-insertion seam
 * the diff and file panels use. That store call is additive: it inserts at the
 * caret when a composer is mounted, appends to the stored prompt when it is
 * not, and touches neither attachments nor model selection.
 *
 * Provenance encoding is deliberately temporary. The review-comment context
 * shape is the only context record this seam can produce today, and its
 * contracts cannot change in this slice, so a sidechat excerpt is encoded into
 * that shape here and only here — `buildSidechatExcerptComment` and
 * `parseSidechatExcerptProvenance` are the pair to replace once a sidechat
 * context record exists. Nothing outside this file reads the encoding.
 */
import * as Schema from "effect/Schema";

import type { ComposerContextAddOptions, ComposerThreadTarget } from "~/composerDraftStore";
import { ReviewCommentContextSchema, type ReviewCommentContext } from "~/reviewCommentContext";

import type { ThreadOrigin } from "./sidechatModel";
import { sidechatOriginPoint } from "@t3tools/client-runtime/state/models";

const isReviewCommentContext = Schema.is(ReviewCommentContextSchema);

/** Section namespace for this encoding. Distinct from "file:" and "pull-request:". */
const SIDECHAT_SECTION_PREFIX = "sidechat:";

export interface SidechatExcerptSource {
  readonly sidechatId: string;
  readonly sidechatTitle: string;
  readonly messageId: string;
  /** How the excerpt's author reads in the transcript ("Assistant", "You"). */
  readonly authorLabel: string;
  readonly text: string;
  readonly origin: ThreadOrigin;
}

export interface SidechatExcerptProvenance {
  readonly sidechatId: string;
  readonly messageId: string;
}

export type SidechatExcerptRefusal =
  /** Nothing was selected, or the selection was only whitespace. */
  | "empty-excerpt"
  /** No main-thread draft to append to. */
  | "no-draft-target"
  /** The excerpt could not be encoded as a valid context record. */
  | "invalid-context";

export type SidechatExcerptAppendResult =
  | { readonly kind: "appended"; readonly comment: ReviewCommentContext }
  | { readonly kind: "refused"; readonly reason: SidechatExcerptRefusal; readonly message: string };

const REFUSAL_MESSAGES: Record<SidechatExcerptRefusal, string> = {
  "empty-excerpt": "Select some text in the sidechat first.",
  "no-draft-target": "The main thread has no composer to add this to.",
  "invalid-context": "This excerpt could not be attached.",
};

function refuse(reason: SidechatExcerptRefusal): SidechatExcerptAppendResult {
  return { kind: "refused", reason, message: REFUSAL_MESSAGES[reason] };
}

/**
 * Stable per (sidechat, message, exact text). Re-quoting the same passage
 * reuses one record; quoting a different passage of the same message makes
 * another, so neither overwrites the other in the draft.
 */
function excerptFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * `filePath` carries a human label rather than a path here, following the
 * existing pull-request summary contexts, which put "PR #12" in the same
 * field. Slashes are stripped because the chip label takes the basename.
 */
function excerptLabel(title: string): string {
  const cleaned = title.replaceAll(/[\\/]+/gu, " ").trim();
  return cleaned.length > 0 ? `Sidechat · ${cleaned}` : "Sidechat";
}

/** Encodes an excerpt as a review-comment context record, or null if empty. */
export function buildSidechatExcerptComment(
  source: SidechatExcerptSource,
): ReviewCommentContext | null {
  const text = source.text.trim();
  if (text.length === 0) return null;
  const sectionId = `${SIDECHAT_SECTION_PREFIX}${encodeURIComponent(source.sidechatId)}/${encodeURIComponent(source.messageId)}`;
  return {
    id: `${sectionId}#${excerptFingerprint(text)}`,
    sectionId,
    sectionTitle: "Sidechat excerpt",
    filePath: excerptLabel(source.sidechatTitle),
    startIndex: 0,
    endIndex: 0,
    rangeLabel: source.authorLabel.trim() || "excerpt",
    // The note the model reads first: where this came from, in the main
    // thread's own terms, so the quote is never free-floating.
    text: [
      `Quoted from the sidechat "${source.sidechatTitle}" (${source.authorLabel}).`,
      `Forked from turn ${sidechatOriginPoint(source.origin)} of this thread.`,
    ].join("\n"),
    diff: text,
    // Never "diff": that language makes the renderable-patch path treat the
    // quote as a patch to apply.
    fenceLanguage: "markdown",
  };
}

/** The inverse of the encoding above. Returns null for any other record. */
export function parseSidechatExcerptProvenance(
  comment: Pick<ReviewCommentContext, "sectionId">,
): SidechatExcerptProvenance | null {
  if (!comment.sectionId.startsWith(SIDECHAT_SECTION_PREFIX)) return null;
  const parts = comment.sectionId.slice(SIDECHAT_SECTION_PREFIX.length).split("/");
  if (parts.length !== 2) return null;
  const [sidechatId, messageId] = parts;
  if (!sidechatId || !messageId) return null;
  try {
    return {
      sidechatId: decodeURIComponent(sidechatId),
      messageId: decodeURIComponent(messageId),
    };
  } catch {
    return null;
  }
}

/**
 * Adds one excerpt to the main thread's draft. Never sends, never replaces:
 * `addReviewComment` appends the reference to the main draft, leaving
 * the rest of the draft — text, attachments, model selection — untouched.
 *
 * `allowDuplicateReference` is on so quoting the same passage a second time
 * still places another chip instead of silently doing nothing. Appending is
 * explicit rather than caret-relative because the caller may be standalone.
 */
export function appendSidechatExcerptToMainDraft(input: {
  target: ComposerThreadTarget | null;
  source: SidechatExcerptSource;
  addReviewComment: (
    target: ComposerThreadTarget,
    comment: ReviewCommentContext,
    options?: ComposerContextAddOptions,
  ) => void;
}): SidechatExcerptAppendResult {
  const comment = buildSidechatExcerptComment(input.source);
  if (comment === null) return refuse("empty-excerpt");
  if (input.target === null) return refuse("no-draft-target");
  // The store drops records that fail this same check without telling anyone.
  // Checking here turns that into a refusal the panel can show.
  if (!isReviewCommentContext(comment)) return refuse("invalid-context");
  input.addReviewComment(input.target, comment, {
    allowDuplicateReference: true,
    insertAtCaret: false,
  });
  return { kind: "appended", comment };
}
