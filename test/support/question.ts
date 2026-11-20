/** Same structured human-answer envelope as OpenCode's built-in question tool.
 *  Result prose deliberately carries no answer: only metadata can prove it. */
export function questionRow(answers: readonly (readonly string[])[], id = "call_question") {
  return { id: `row_${id}`, type: "assistant", content: [{ type: "tool", id, name: "question", state: {
    status: "completed", input: { questions: answers.map((_, at) => ({ header: "Preference", question: `Preference ${at + 1}?`,
      options: [{ label: "Continue", description: "Keep working." }] })) },
    metadata: { answers }, content: [{ type: "text", text: "User has answered your questions." }],
  } }] }
}
