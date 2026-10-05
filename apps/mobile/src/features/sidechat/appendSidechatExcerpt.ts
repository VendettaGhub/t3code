import {
  ComposerContextId,
  type EnvironmentId,
  type MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";

import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  getComposerDraftSnapshot,
  insertComposerDraftContext,
} from "../../state/use-composer-drafts";
import { uuidv4 } from "../../lib/uuid";

export function appendSidechatExcerptToMainDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly mainThreadId: ThreadId;
  readonly sidechatId: ThreadId;
  readonly sourceMessageId: MessageId;
  readonly sidechatTitle: string;
  readonly excerpt: string;
}): boolean {
  const excerpt = input.excerpt.trim();
  if (excerpt.length === 0) return false;

  const record = {
    version: 1 as const,
    kind: "sidechat-excerpt" as const,
    contextId: ComposerContextId.make(uuidv4()),
    label: `${input.sidechatTitle} · selected message`,
    payload: {
      sidechatId: String(input.sidechatId),
      sourceMessageId: String(input.sourceMessageId),
      excerpt,
    },
  };

  const draftKey = scopedThreadKey(input.environmentId, input.mainThreadId);
  const draft = getComposerDraftSnapshot(draftKey);
  return insertComposerDraftContext(
    draftKey,
    {
      text: `${formatComposerContextReference(record)}\n${excerpt}`,
      context: { version: 1, records: [record] },
    },
    { text: draft.text, start: draft.text.length, end: draft.text.length },
  );
}
