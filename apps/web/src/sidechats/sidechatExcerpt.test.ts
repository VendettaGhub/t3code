import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, TurnId, type EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerContextAddOptions, ComposerThreadTarget } from "~/composerDraftStore";
import { reviewCommentContextLabel } from "~/lib/composerContextRecords";
import type { ReviewCommentContext } from "~/reviewCommentContext";

import {
  appendSidechatExcerptToMainDraft,
  buildSidechatExcerptComment,
  parseSidechatExcerptProvenance,
  type SidechatExcerptSource,
} from "./sidechatExcerpt";

const target = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("main"));

const source = (overrides: Partial<SidechatExcerptSource> = {}): SidechatExcerptSource => ({
  sidechatId: "sc-1",
  sidechatTitle: "Alternative approach",
  messageId: "msg-9",
  authorLabel: "Assistant",
  text: "Use a queue instead of a lock.",
  origin: {
    threadId: ThreadId.make("main"),
    turnId: TurnId.make("turn-7"),
    createdAt: "2026-09-01T00:00:00.000Z",
  },
  ...overrides,
});

function recorder() {
  const calls: Array<{
    target: ComposerThreadTarget;
    comment: ReviewCommentContext;
    options: ComposerContextAddOptions | undefined;
  }> = [];
  return {
    calls,
    addReviewComment: (
      callTarget: ComposerThreadTarget,
      comment: ReviewCommentContext,
      options?: ComposerContextAddOptions,
    ) => {
      calls.push({ target: callTarget, comment, options });
    },
  };
}

describe("sidechat excerpt encoding", () => {
  it("round-trips provenance through the review-comment shape", () => {
    // The only encoding of sidechat provenance in the app. It has to survive
    // ids that contain the delimiters.
    const comment = buildSidechatExcerptComment(source({ sidechatId: "a/b:c", messageId: "m/1" }));
    expect(comment).not.toBeNull();
    expect(parseSidechatExcerptProvenance(comment!)).toEqual({
      sidechatId: "a/b:c",
      messageId: "m/1",
    });
  });

  it("does not claim other review comments as sidechat excerpts", () => {
    expect(parseSidechatExcerptProvenance({ sectionId: "file:src/app.ts" })).toBeNull();
    expect(parseSidechatExcerptProvenance({ sectionId: "pull-request:12" })).toBeNull();
    expect(parseSidechatExcerptProvenance({ sectionId: "sidechat:only-one-part" })).toBeNull();
  });

  it("names the sidechat in the chip label rather than a fake file path", () => {
    const comment = buildSidechatExcerptComment(source())!;
    expect(reviewCommentContextLabel(comment)).toContain("Alternative approach");
    expect(reviewCommentContextLabel(comment)).toContain("Assistant");
  });

  it("keeps the quote out of the diff-patch path", () => {
    // fenceLanguage "diff" would make the renderable-patch builder treat the
    // quoted prose as a patch to apply.
    expect(buildSidechatExcerptComment(source())!.fenceLanguage).not.toBe("diff");
  });

  it("carries the origin turn in the note the model reads", () => {
    expect(buildSidechatExcerptComment(source())!.text).toContain("turn-7");
  });

  it("refuses an empty or whitespace-only selection", () => {
    expect(buildSidechatExcerptComment(source({ text: "   \n " }))).toBeNull();
  });

  it("separates different passages of one message and reuses one record per passage", () => {
    const first = buildSidechatExcerptComment(source({ text: "one" }))!;
    const second = buildSidechatExcerptComment(source({ text: "two" }))!;
    const repeat = buildSidechatExcerptComment(source({ text: "one" }))!;
    expect(first.id).not.toBe(second.id);
    expect(first.id).toBe(repeat.id);
  });
});

describe("appending an excerpt to the main draft", () => {
  it("adds through the composer draft seam without sending or replacing", () => {
    const store = recorder();
    const result = appendSidechatExcerptToMainDraft({
      target,
      source: source(),
      addReviewComment: store.addReviewComment,
    });
    expect(result.kind).toBe("appended");
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.target).toBe(target);
    // Additive and end-appended: standalone sidechat routes must not mutate a
    // mounted main composer's current selection.
    expect(store.calls[0]!.options).toMatchObject({
      allowDuplicateReference: true,
      insertAtCaret: false,
    });
    expect(store.calls[0]!.options?.appendReference).toBeUndefined();
  });

  it("refuses an empty selection and writes nothing", () => {
    const store = recorder();
    const result = appendSidechatExcerptToMainDraft({
      target,
      source: source({ text: "  " }),
      addReviewComment: store.addReviewComment,
    });
    expect(result).toMatchObject({ kind: "refused", reason: "empty-excerpt" });
    expect(store.calls).toHaveLength(0);
  });

  it("refuses when there is no main-thread draft to append to", () => {
    const store = recorder();
    const result = appendSidechatExcerptToMainDraft({
      target: null,
      source: source(),
      addReviewComment: store.addReviewComment,
    });
    expect(result).toMatchObject({ kind: "refused", reason: "no-draft-target" });
    expect(store.calls).toHaveLength(0);
  });

  it("produces a record the draft store will actually keep", () => {
    // The store drops records failing its schema check without telling anyone;
    // an invalid encoding here would look like a successful no-op.
    const store = recorder();
    appendSidechatExcerptToMainDraft({
      target,
      source: source(),
      addReviewComment: store.addReviewComment,
    });
    const comment = store.calls[0]!.comment;
    expect(comment.diff).toBe("Use a queue instead of a lock.");
    expect(comment.startIndex).toBe(0);
    expect(comment.endIndex).toBe(0);
  });
});
