export type SideQuestionCommand = { readonly question: string | null };

export function parseSideQuestionCommand(input: string): SideQuestionCommand | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/iu.exec(input.trim());
  if (!match) return null;
  const question = match[1]?.trim() ?? "";
  return { question: question.length > 0 ? question : null };
}
