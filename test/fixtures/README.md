# Synthetic message fixtures

Synthetic `event.messages` dumps from an isolated throwaway OpenCode 2.2.0
session. All prompts and tool outputs are synthetic; the IDs and tool names
belong to that throwaway session and were renamed where they named the test
harness. No headers, credentials, or other provider response data were
captured.

- `before-mask.json` and `after-mask-1.json`: the same request before and
  after eliding one tool result. The second tool output remains intact.
- `compaction-unmasked.json`: the messages received by the compaction hook.
- `generate-mask-2.json`: the summary generation request, with both tool
  results masked by the generate hook.
- `post-compaction.json`: the following request, including the native
  checkpoint and its retained recent tail.

The before/after pair demonstrates that tool-result messages can lack a
message ID even though their individual parts have call IDs. The files are
golden inputs for `test/mask.test.mjs` and `test/store.test.mjs`.
