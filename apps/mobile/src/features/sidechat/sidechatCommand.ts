export type SideQuestionCommand = { readonly question: string | null };

// Only a local /btw action may send the newly created child's draft. Route
// parameters and restored navigation state never authorize a send.
const pendingSends = new Map<string, string>();

export function armSideQuestionSend(threadKey: string, draft: string): void {
  pendingSends.set(threadKey, draft);
}

export function consumeSideQuestionSend(threadKey: string, draft: string): boolean {
  const expected = pendingSends.get(threadKey);
  pendingSends.delete(threadKey);
  return expected !== undefined && expected === draft;
}

export function parseSideQuestionCommand(input: string): SideQuestionCommand | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/iu.exec(input.trim());
  if (!match) return null;
  const question = match[1]?.trim() ?? "";
  return { question: question.length > 0 ? question : null };
}
