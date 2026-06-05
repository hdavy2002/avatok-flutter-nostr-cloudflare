// Robust text extraction across Workers AI chat response shapes:
//  • `{ response: "..." }`                         — Llama, Gemma 3
//  • `{ choices: [{ message: { content, reasoning } }] }` — Gemma 4 (OpenAI-style;
//    `reasoning` holds the thinking-mode chain, `content` the final answer)
// Prefer the final content; fall back to reasoning, then description.
export function aiText(out: any): string {
  if (!out) return "";
  if (typeof out.response === "string") return out.response;
  const m = out.choices?.[0]?.message;
  if (m) return (m.content ?? m.reasoning ?? "") as string;
  return (out.description ?? "") as string;
}
