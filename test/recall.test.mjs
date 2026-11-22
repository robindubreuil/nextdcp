import assert from "node:assert/strict"
import test from "node:test"
import { address, formatCall, formatCatalog, formatCatalogEntry, formatGraduated, formatRow, formatTranscript, LAYERS, paginate, parseTarget, recallPage, resolveHandle, search, shortId, TAG_INPUT_CHARS, RECALL_ALL_CHARS, RECALL_PAGE_CHARS } from "../src/recall.ts"
import { formatSpan, recencyBoost } from "../src/time.ts"

test("graduated originals have stable provenance bytes and search pages fetch the matching text", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 })
  const note = { id: "P1", session: "ses_origin", end: 1_000, note: `${"filler ".repeat(855)} pageboundaryneedle ${"tail ".repeat(1_500)}` }
  const text = formatGraduated(note)
  const [hit] = search("pageboundaryneedle", [{ id: note.id, text }])
  assert.ok(hit)
  assert.match(paginate(text, hit.page).content, /pageboundaryneedle/)
  t.mock.timers.tick(86_400_000)
  assert.equal(formatGraduated(note), text, "relative age must not move any paginated content")
  assert.match(text, /Graduated session note P1 \(from session ses_origin\)/)
})

test("BM25 ranks matching archive and live documents and breaks ties deterministically", () => {
  const documents = [
    { id: "E2", text: "banana grape" },
    { id: "E1", text: "banana apple" },
    { id: "call-live", text: "banana banana banana apple apple" },
    { id: "unrelated", text: "pear" },
  ]
  const hits = search("banana", documents)
  assert.deepEqual(hits.map((hit) => hit.id), ["call-live", "E1", "E2"])
  assert.ok(hits[0].score > hits[1].score)
  assert.equal(hits[1].score, hits[2].score)
  assert.equal(hits[0].snippet, documents[2].text)
  assert.deepEqual(search("banana", documents, 1).map((hit) => hit.id), ["call-live"])
  assert.deepEqual(search("???", documents), [])
  assert.deepEqual(search("missing", documents), [])
  assert.throws(() => search("banana", documents, 0), /positive/)
})

test("focused recall ranks small passages, not an entire long document or its first matching word", () => {
  const text = "needle " + "noise ".repeat(2_000) + "The exact needle error was fixed in src/working.ts; do not retry the old patch. " + "noise ".repeat(2_000)
  const hits = search("needle error working", [{ id: "E1", text }])
  assert.match(hits[0].snippet, /exact needle error was fixed in src\/working.ts; do not retry/)
  assert.ok(hits[0].snippet.length <= 902)
  assert.ok(hits[0].page > 1)
  const allText = paginate(text, hits[0].page).content
  assert.match(allText, /exact needle error/)
})

test("identical evidence is deduplicated and archive-only search notes are explicitly labeled", () => {
  const hits = search("needle", [{ id: "E2", text: "same needle evidence" }, { id: "E1", text: "same needle evidence" }])
  assert.deepEqual(hits.map((hit) => hit.id), ["E1"])
  assert.deepEqual(hits[0].also, [{ id: "E2", page: 1 }])
  const [note] = search("selector", [{ id: "E3", text: "The raw transcript uses other words." }, { id: "E3#note", note: true, text: "Compaction model selector; src/picker.ts." }])
  assert.equal(note.note, true)
  assert.equal(note.id, "E3#note")
  assert.equal(note.page, 1)
  assert.match(note.snippet, /selector/)
})

test("repeated copies of one evidence region collapse into one hit with fetchable locations", () => {
  const core = "physics before consent: a grant must fit the window, so no approval is spent on a conversation that overflows anyway"
  const hits = search("physics consent grant window approval", [
    { id: "E5", text: `read output 525: 526: // ${core} 527: // tail with window budget notes` },
    { id: "E4", text: `edit input: ${core} plus a different tail about window sizes` },
    { id: "E1", text: "separate topic: window and grant sizing in recall budgets" },
  ])
  assert.equal(hits.length, 2)
  const group = hits.find((hit) => hit.also?.length)
  assert.ok(group, "the near-identical excerpts form one hit")
  assert.deepEqual([group.id, ...group.also.map((location) => location.id)].sort(), ["E4", "E5"])
  assert.deepEqual(group.also.map((location) => location.page), [1])
  assert.ok(hits.some((hit) => hit.id === "E1" && !hit.also), "distinct evidence survives untouched")
})

test("short identical match cores with distinct snippets stay separate hits", () => {
  const hits = search("needle", [{ id: "E1", text: "needle here in alpha context" }, { id: "E2", text: "needle there in beta context" }])
  assert.deepEqual(hits.map((hit) => hit.id), ["E1", "E2"])
  assert.ok(hits.every((hit) => !hit.also))
})

test("a stray term echo near one copy does not split the group", () => {
  const core = "physics before consent: a grant must fit the window, so no approval is spent on a conversation that overflows anyway"
  const filler = "neutral words repeat ".repeat(20)
  const hits = search("physics consent grant window approval", [
    { id: "E1", text: `${core} and a plain tail` },
    { id: "E2", text: `grant ${filler.slice(0, 400)} ${core} ${filler.slice(0, 250)} window` },
  ])
  assert.equal(hits.length, 1)
  assert.deepEqual([hits[0].id, ...hits[0].also.map((location) => location.id)].sort(), ["E1", "E2"])
})

test("recall echoes are excluded from scoring while the original evidence still ranks", () => {
  const quoted = "needle quoted verbatim inside a recall result "
  const echo = quoted.repeat(20)
  const text = `${echo}${"plain context ".repeat(15)}genuine needle evidence lives here`
  const [hit] = search("needle", [{ id: "E1", text, echoes: [[0, echo.length]] }])
  assert.match(hit.snippet, /genuine needle evidence/)
  assert.doesNotMatch(hit.snippet, /quoted verbatim/, "the window centers on genuine content")
  assert.deepEqual(search("needle", [{ id: "E2", text: echo, echoes: [[0, echo.length]] }]), [], "an echo-only page never competes")
})

test("echo exclusion is score-deep only: hit pages stay aligned with fetchable text", () => {
  const echo = "noise ".repeat(1_200) // spans past the first 6k-char page
  const text = `${echo}genuine needle after the echo`
  const [hit] = search("needle", [{ id: "E1", text, echoes: [[0, echo.length]] }])
  assert.equal(hit.page, 2, "the match sits on page 2 of the unchanged text")
  assert.match(paginate(text, hit.page).content, /genuine needle/)
})

test("formatTranscript marks recall renderings as echoes, and only those", () => {
  const row = { id: "m1", type: "assistant", content: [
    { type: "text", text: "checking" },
    { type: "tool", name: "recall", state: { input: { query: "x" }, status: "completed", content: [{ type: "text", text: "Historical evidence, page 1\n- recall {\"id\":\"E1\",\"page\":1}: quoted core" }] } },
    { type: "tool", name: "read", state: { input: { path: "a.ts" }, status: "completed", content: [{ type: "text", text: "genuine file content" }] } },
  ] }
  const echoes = []
  const text = formatTranscript("E1", [{ id: "m1", text: JSON.stringify(row) }], { echoes })
  assert.equal(echoes.length, 1)
  const [start, end] = echoes[0]
  assert.match(text.slice(start, end), /^\[Tool recall /)
  assert.match(text.slice(start, end), /quoted core/)
  assert.doesNotMatch(text.slice(start, end), /genuine file content/)
  assert.match(text, /genuine file content/, "the rendering itself keeps every byte")
})

test("search is Unicode-normalized and snippets do not split surrogate pairs", () => {
  const documents = [
    { id: "E1", text: "A CAFÉ and the 東京 station" },
    { id: "E2", text: "x".repeat(999) + "😀" + "x".repeat(5) + " needle " + "y".repeat(1_000) },
  ]
  assert.deepEqual(search("cafe\u0301", documents).map((hit) => hit.id), ["E1"])
  assert.deepEqual(search("東京", documents).map((hit) => hit.id), ["E1"])
  const hit = search("needle", documents)[0]
  assert.equal(hit.id, "E2")
  assert.match(hit.snippet, /needle/)
  assert.ok(hit.snippet.startsWith("…") && hit.snippet.endsWith("…"))
  assert.ok(hit.snippet.isWellFormed())
})

test("snippets cut on word boundaries and never open or close on a word fragment", () => {
  const text = "aaaaaa ".repeat(36) + "needle " + "bbbbbb ".repeat(120)
  const [hit] = search("needle", [{ id: "E1", text }])
  assert.ok(hit, "the match is found")
  const words = hit.snippet.replace(/^…|…$/gu, "").split(" ")
  assert.ok(words.every((word) => ["aaaaaa", "needle", "bbbbbb"].includes(word)), `no fragment in ${hit.snippet}`)
  assert.equal(words[0], "aaaaaa", "the snippet opens at a word start")
  assert.equal(words.at(-1), "bbbbbb", "the snippet closes at a word end")
  assert.equal(words.filter((word) => word === "needle").length, 1)
  assert.ok(hit.snippet.startsWith("…") && hit.snippet.endsWith("…"), "both ends show the text is truncated")
})

test("~1.5k-token pages preserve every character and have explicit continuation", () => {
  const text = "a".repeat(RECALL_PAGE_CHARS - 1) + "😀" + "b".repeat(RECALL_PAGE_CHARS) + "𝄞" + "z"
  const first = paginate(text)
  assert.equal(first.page, 1)
  assert.equal(first.pages, 3)
  assert.equal(first.nextPage, 2)
  const pages = Array.from({ length: first.pages }, (_, index) => paginate(text, index + 1))
  assert.equal(pages.map((item) => item.content).join(""), text)
  assert.ok(pages.every((item) => item.content.isWellFormed()))
  assert.equal(pages.at(-1).nextPage, undefined)
  assert.deepEqual(paginate(""), { content: "", page: 1, pages: 1 })
  assert.deepEqual([paginate("x😀y", 1, 2).content, paginate("x😀y", 2, 2).content, paginate("x😀y", 3, 2).content], ["x", "😀", "y"])
  assert.throws(() => paginate(text, 0), /Invalid/)
  assert.throws(() => paginate(text, 4), /between 1 and 3/)
  assert.throws(() => paginate(text, 1, 1), /Invalid/)
})

test("id recall without page returns the whole original in one call", () => {
  const small = "a".repeat(RECALL_PAGE_CHARS * 3)
  const whole = recallPage("call-1", small)
  assert.match(whole, /^recall id=call-1 \(whole output\)\n/)
  assert.ok(whole.endsWith(small))
  const big = "b".repeat(RECALL_PAGE_CHARS * 7) + "😀 tail"
  const head = recallPage("call-2", big)
  const body = head.slice(head.indexOf("\n") + 1)
  assert.match(head, /^recall id=call-2 \(whole output too large: first 30000 of 42007 characters; use a query to locate the relevant page first, or continue at page 6\)\n/)
  assert.equal(body, big.slice(0, RECALL_ALL_CHARS))
  const rest = Array.from({ length: 3 }, (_, index) => paginate(big, index + 6).content).join("")
  assert.equal(body + rest, big)
  assert.equal(recallPage("empty", ""), "recall id=empty (whole output)\n")
  const files = []
  const text = formatCall({ id: "call-3", name: "read", input: {}, result: { type: "content", value: [{ type: "text", text: "x ".repeat(3_500) }, { type: "file", uri: "file:///x", mime: "image/png" }] } }, files)
  const withFile = recallPage("call-3", text, undefined, files)
  assert.ok(Array.isArray(withFile), "attachment labels come with their native file")
  assert.deepEqual(withFile.slice(1).map((file) => file.uri), ["file:///x"])
})

test("recall output contains complete original tool input and text or structured output", () => {
  const input = { path: "dir/file.ts", content: "é😀".repeat(5_000) }
  const value = "unclipped\n" + "output".repeat(8_000)
  const text = formatCall({ id: "call-1", name: "write", input, result: { type: "text", value } })
  assert.ok(text.startsWith("Tool call call-1\nTool: write\nInput:\n"))
  assert.ok(text.includes(JSON.stringify(input, null, 2)))
  assert.ok(text.endsWith(value))
  const mixed = [{ type: "text", text: "full" }, { type: "file", uri: "file:///x", mime: "image/png" }]
  const files = []
  const formatted = formatCall({ id: "call-2", name: "read", input: {}, result: { type: "content", value: mixed } }, files)
  assert.match(formatted, /full\n\[Attached image\/png: file:\/\/\/x\]/)
  assert.deepEqual(recallPage("call-2", formatted, 1, files).slice(1), [mixed[1]])
})

test("episode transcripts render readable full content without row or provider metadata", () => {
  const output = "full output\n" + "payload ".repeat(6_000) + "end of output"
  const rows = [
    { id: "row-user-secret", type: "user", text: "exact question", time: { created: 123 }, metadata: { trace: "private-user-metadata" } },
    { id: "row-assistant-secret", type: "assistant", time: { created: 456 }, tokens: { input: 99 }, cost: 8, content: [
      { type: "text", text: "useful answer", providerMetadata: { signature: "private-signature" } },
      { type: "reasoning", text: "private-reasoning", providerMetadata: { signature: "private-signature" } },
      { type: "tool", id: "tool-secret", name: "read", state: { status: "completed", input: { filePath: "src/x.ts" }, content: [
        { type: "text", text: output }, { type: "file", uri: "file:///x.png", mime: "image/png" },
      ] } },
    ] },
    { id: "row-shell-secret", type: "shell", command: "node test", output: { output: "shell output" } },
    { id: "row-synthetic-secret", type: "synthetic", text: "continued" },
    { id: "row-checkpoint-secret", type: "compaction", status: "completed", summary: "checkpoint summary" },
  ]
  const transcript = formatTranscript("E3", [...rows.map((row) => ({ id: row.id, text: JSON.stringify(row) })), { id: "missing-secret" }], { gap: true })
  assert.match(transcript, /^Episode E3: raw transcript/)
  assert.match(transcript, /some raw history was not archived/)
  assert.match(transcript, /\[User\]: exact question/)
  assert.match(transcript, /\[Assistant\]: useful answer/)
  assert.ok(transcript.includes(`[Tool read {"filePath":"src/x.ts"}]:\n${output}`))
  assert.match(transcript, /\[Attached image\/png: file:\/\/\/x.png\]/)
  assert.match(transcript, /\[Shell\]: node test\nshell output/)
  assert.match(transcript, /\[Synthetic\]: continued/)
  assert.match(transcript, /\[Checkpoint\]: checkpoint summary/)
  assert.match(transcript, /Unavailable archived row; recall gap/)
  assert.doesNotMatch(transcript, /row-(?:user|assistant|shell|synthetic|checkpoint)-secret|missing-secret|tool-secret|private-(?:user-metadata|signature|reasoning)|"tokens"|"cost"/)
  assert.match(formatTranscript("E4", [{ id: "bad", text: "invalid JSON" }]), /Invalid archived row; recall gap/)
})

test("archive search hits point to the exact page that contains the snippet", () => {
  const text = "a ".repeat(17_000) + " rarearchiveneedle " + "b ".repeat(17_000)
  const transcript = formatTranscript("E3", [{ id: "row-id", text: JSON.stringify({ id: "row-id", type: "user", text, metadata: { secret: "not-indexed" } }) }])
  const docs = [{ id: "E3", text: transcript }]
  const hit = search("rarearchiveneedle", docs)[0]
  assert.equal(hit.id, "E3")
  assert.equal(hit.page, Math.floor(transcript.indexOf("rarearchiveneedle") / RECALL_PAGE_CHARS) + 1)
  assert.match(paginate(transcript, hit.page).content, /rarearchiveneedle/)
  assert.deepEqual(search("not-indexed", docs), [])
})

test("elided tool data is searchable by page of the formatted call", () => {
  const input = { path: "visiblepath", content: "x ".repeat(18_000) + " hiddeninputneedle " + "y ".repeat(4_000) }
  const output = "a ".repeat(17_000) + " hiddenoutputneedle " + "b ".repeat(4_000)
  const text = formatCall({ id: "call-1", name: "write", input, result: { type: "text", value: output } })
  const docs = [{ id: "call-1", text }]
  for (const needle of ["hiddeninputneedle", "hiddenoutputneedle"]) {
    const hit = search(needle, docs)[0]
    assert.equal(hit.id, "call-1")
    assert.match(paginate(text, hit.page).content, new RegExp(needle))
  }
  assert.deepEqual(search("needle", [{ id: "E1", text: "" }]), [])
})

test("search never loses a token crossing a page boundary", () => {
  const marker = "UNIQUE_BOUNDARY_MARKER"
  const text = "a ".repeat(RECALL_PAGE_CHARS / 2 - 3) + marker + " tail"
  assert.ok(text.indexOf(marker) < RECALL_PAGE_CHARS && text.indexOf(marker) + marker.length > RECALL_PAGE_CHARS)
  const [hit] = search(marker, [{ id: "E1", text }])
  assert.equal(hit.id, "E1")
  assert.equal(hit.page, 1)
  assert.match(hit.snippet, /UNIQUE_BOUNDARY_MARKER/)
  assert.ok((paginate(text, hit.page).content + paginate(text, hit.page + 1).content).includes(marker))
  const astral = "😀".repeat(15_999) + " " + marker + " tail"
  assert.equal(search(marker, [{ id: "E2", text: astral }]).length, 1)
})

test("media recall returns original native files only on their own page, without base64 text", () => {
  const image = { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png", name: "chart.png" }
  const files = []
  const text = formatCall({ id: "media", name: "read", input: {}, result: { type: "content", value: [{ type: "text", text: "x ".repeat(3_500) }, image] } }, files)
  assert.equal(typeof recallPage("media", text, 1, files), "string")
  const page = recallPage("media", text, 2, files)
  assert.deepEqual(page.slice(1), [image])
  assert.doesNotMatch(page[0].text, /base64|AAAA/)
  assert.equal(recallPage("media", text, 3, files), "recall id=media page 3 is out of range: this original has 2 pages; the last page is 2.")
  const errorFiles = []
  const error = formatCall({ id: "error", name: "read", input: {}, result: { type: "error", value: { error: "failed", content: [image] } } }, errorFiles)
  assert.match(error, /failed/)
  assert.deepEqual(recallPage("error", error, 1, errorFiles).slice(1), [image])
  const json = { content: [{ type: "text", text: "not a tool content result" }], important: 42 }
  assert.ok(formatCall({ id: "json", name: "read", input: {}, result: { type: "json", value: json } }).includes(JSON.stringify(json, null, 2)))
  const repeatedFiles = []
  const repeated = formatCall({ id: "repeated", name: "read", input: {}, result: { type: "content", value: [
    { type: "text", text: "[Attached image/png: chart.png]\n" + "x ".repeat(3_500) }, image,
  ] } }, repeatedFiles)
  assert.equal(typeof recallPage("repeated", repeated, 1, repeatedFiles), "string", "a label in ordinary text must not move the file to the wrong page")
  assert.deepEqual(recallPage("repeated", repeated, 2, repeatedFiles).slice(1), [image])
})

test("user attachments retain inline bytes, searchable text, and native PDFs/images", () => {
  const files = []
  const input = { id: "u", type: "user", text: "question", files: [
    { mime: "image/png", name: "chart.png", data: "AAAA", source: { type: "uri", uri: "file:///changed.png" } },
    { mime: "application/pdf", name: "doc.pdf", data: "BBBB", source: { type: "inline" } },
    { mime: "text/plain", name: "notes.txt", data: Buffer.from("searchable café").toString("base64"), source: { type: "inline" } },
  ] }
  const text = formatTranscript("E1", [{ id: "u", text: JSON.stringify(input) }], { files })
  const result = recallPage("E1", text, 1, files)
  assert.deepEqual(result.slice(1).map((file) => file.uri), ["data:image/png;base64,AAAA", "data:application/pdf;base64,BBBB"])
  assert.match(result[0].text, /searchable café/)
  assert.doesNotMatch(result[0].text, /AAAA|BBBB|base64/)
  assert.equal(search("searchable", [{ id: "E1", text }]).length, 1)
})

test("layer matrix: conversation renders runnable tags, tools the originals, full interleaves both", () => {
  const rows = [
    { id: "u1", type: "user", text: "exact user question", time: { created: 1 } },
    { id: "a1", type: "assistant", time: { created: 2 }, content: [
      { type: "reasoning", text: "hidden reasoning" },
      { type: "text", text: "useful answer" },
      { type: "tool", id: "call-1", name: "read", state: { status: "completed", input: { path: "a.ts" }, content: [{ type: "text", text: "inline state output" }] } },
      { type: "tool", id: "call-echo", name: "recall", state: { status: "completed", input: { query: "old" }, content: [{ type: "text", text: "quoted old evidence" }] } },
    ] },
    { id: "sh1", type: "shell", command: "node test", output: { output: "shell output" } },
  ].map((row) => ({ id: row.id, text: JSON.stringify(row) }))
  const call = (id) => id === "call-1" ? { id, name: "read", input: { path: "a.ts" }, result: { type: "text", value: "original output from calls/" } } : undefined

  const conversation = formatTranscript("E9", rows, { layer: "conversation", call })
  assert.match(conversation, /^Episode E9 — conversation/)
  assert.match(conversation, /\[User\]: exact user question/)
  assert.match(conversation, /\[Assistant\]: useful answer/)
  assert.match(conversation, /\[Tool read \{"path":"a\.ts"\} → recall id=call-1\]/)
  assert.match(conversation, /\[Tool recall \{"query":"old"\} → recall id=call-echo\]/)
  assert.match(conversation, /\[Shell node test → recall id=sh1\]/)
  assert.doesNotMatch(conversation, /inline state output|original output from calls\/|shell output|quoted old evidence/, "commands are tags; every output is one hop away")

  const tools = formatTranscript("E9", rows, { layer: "tools", call })
  assert.match(tools, /^Episode E9 — tool output/)
  assert.ok(tools.includes(`[Tool read {"path":"a.ts"}]:\noriginal output from calls/`), "tools layer renders the call original, not the in-row state")
  assert.ok(tools.includes(`[Tool recall {"query":"old"}]:\nquoted old evidence`))
  assert.ok(tools.includes(`[Shell]: node test\nshell output`))
  assert.doesNotMatch(tools, /exact user question|useful answer/, "no dialogue at the tools depth")

  const full = formatTranscript("E9", rows, { layer: "full", call })
  assert.match(full, /^Episode E9: raw transcript/)
  for (const fragment of ["exact user question", "useful answer", "original output from calls/", "shell output"]) assert.ok(full.includes(fragment))
  for (const text of [conversation, tools, full]) assert.doesNotMatch(text, /hidden reasoning/, "reasoning is never rendered")
})

test("conversation tags identify heavy calls without carrying them; originals stay one hop away", () => {
  const script = `#!/usr/bin/env python3\n` + Array.from({ length: 120 }, (_, i) => `print("step ${i} of the hand rolled script")`).join("\n")
  const rows = [
    { id: "u1", type: "user", text: "run the migration" },
    { id: "a1", type: "assistant", content: [
      { type: "text", text: "writing it live" },
      { type: "tool", id: "call-write", name: "write", state: { status: "completed", input: { path: "migrate.py", content: script }, content: [] } },
    ] },
    { id: "sh1", type: "shell", command: `python3 - <<'EOF'\n${script}\nEOF`, output: { output: "done" } },
  ].map((row) => ({ id: row.id, text: JSON.stringify(row) }))
  const call = { id: "call-write", name: "write", input: { path: "migrate.py", content: script }, result: { type: "text", value: "wrote it" } }
  const resolve = (id) => (id === "call-write" ? call : undefined)

  const conversation = formatTranscript("E9", rows, { layer: "conversation", call: resolve })
  const toolTag = conversation.split("\n").find((line) => line.startsWith("[Tool write"))
  assert.ok(toolTag !== undefined)
  assert.match(toolTag, /… \(\+\d+ chars\) → recall id=call-write\]$/)
  assert.ok(toolTag.length < "[Tool write ".length + TAG_INPUT_CHARS + 30 + " → recall id=call-write]".length, "a heavy input leaves only its head in the tag")
  assert.ok(!conversation.includes("step 119"), "the conversation layer carries the tag head, not the script body")

  const shellStart = conversation.indexOf("[Shell python3")
  const shellTag = conversation.slice(shellStart, conversation.indexOf("→ recall id=sh1]", shellStart) + 16)
  assert.ok(shellTag.includes("… (+"), "a heredoc command is capped like a tool input")
  assert.ok(!shellTag.includes("step 119"))

  // What the tag drops stays one hop away: the full layer and the call original keep the script
  // (the original carries it JSON-escaped; the full layer's shell row carries it raw).
  const full = formatTranscript("E9", rows, { layer: "full", call: resolve })
  assert.ok(full.includes(script), "the full layer stays the complete raw transcript")
  const original = formatCall(call)
  assert.ok(original.includes("step 119 of the hand rolled script"), "the call original keeps the whole input")

  // Script content's search home is its original, not the dialogue.
  const documents = [
    { id: "E9", text: conversation, layer: "conversation" },
    { id: "call-write", text: original, layer: "tools" },
    { id: "sh1", text: formatRow(rows[2].text, resolve), layer: "tools" },
  ]
  assert.deepEqual(search("119", documents, 40, "conversation"), [], "script bodies are not conversation homes")
  assert.deepEqual(new Set(search("119", documents, 40, "full").map((hit) => hit.id)), new Set(["call-write", "sh1"]))
})

test("tag caps land exactly: no marker at the boundary, no split surrogate pairs", () => {
  const at = (path) => [{ id: "a", type: "assistant", content: [
    { type: "tool", id: "call-1", name: "write", state: { status: "completed", input: { path }, content: [] } },
  ] }]
  const render = (path) => formatTranscript("E1", at(path).map((row) => ({ id: row.id, text: JSON.stringify(row) })), { layer: "conversation" })
  // `{"path":"` + 189 + `"}` is exactly TAG_INPUT_CHARS: shown whole, no marker.
  const exact = render("x".repeat(TAG_INPUT_CHARS - 11))
  assert.ok(exact.includes(`[Tool write {"path":"${"x".repeat(TAG_INPUT_CHARS - 11)}"} → recall id=call-1]`))
  assert.ok(!exact.includes("… (+"))
  // One char over: the marker names exactly what was omitted.
  assert.match(render("x".repeat(TAG_INPUT_CHARS - 10)), /… \(\+1 chars\) → recall id=call-1\]/)
  // A surrogate pair straddling the cut is kept whole: the last shown char is not a lone high surrogate.
  const emoji = render("x".repeat(TAG_INPUT_CHARS - 10) + "😀".repeat(30))
  const head = emoji.slice(emoji.indexOf('"path":"') + 8, emoji.indexOf("… (+"))
  const units = [...head]
  const last = units.at(-1)
  assert.ok(last !== undefined && last.length === 1 && last.charCodeAt(0) < 0xd800, "the cut never ends on a lone high surrogate")
  assert.match(emoji, /… \(\+\d+ chars\) → recall id=call-1\]/)
})

test("injected content tags in conversation, homes in the row original: skills and inline text", () => {
  const skillBody = Array.from({ length: 60 }, (_, index) => `skill directive line ${index} for the bench phone`).join("\n")
  const reportBody = Array.from({ length: 30 }, (_, index) => `report skill body line ${index}`).join("\n")
  const logText = "attached bench log line ".repeat(300)
  const rows = [
    { id: "msg_user1", type: "user", text: "use the companion skill", skills: [{ name: "companion", text: skillBody }], files: [
      { mime: "text/plain", name: "benchlog.txt", data: Buffer.from(logText).toString("base64") },
      { mime: "image/png", name: "chart.png", data: "AAAA", source: { type: "uri", uri: "file:///chart.png" } },
    ] },
    { id: "msg_skill1", type: "skill", name: "report", text: reportBody },
  ].map((row) => ({ id: row.id, text: JSON.stringify(row) }))

  const conversationFiles = []
  const conversation = formatTranscript("E2", rows, { layer: "conversation", files: conversationFiles })
  assert.match(conversation, /\[User\]: use the companion skill/)
  assert.match(conversation, new RegExp(`\\[Skill activated: companion \\(${skillBody.length} chars\\) → recall id=msg_user1\\]`))
  assert.match(conversation, /\[Attached text\/plain: benchlog\.txt \(\d+ chars\) → recall id=msg_user1\]/)
  assert.match(conversation, /\[Skill activated: report \(\d+ chars\) → recall id=msg_skill1\]/)
  assert.match(conversation, /\[Attached image\/png: chart\.png\]/, "media stays a native label, not a counted tag")
  assert.deepEqual(conversationFiles.map((item) => item.file.uri), ["data:image/png;base64,AAAA"])
  assert.ok(!conversation.includes("skill directive line 30") && !conversation.includes("bench log line"), "injected bodies never ride the dialogue")

  const full = formatTranscript("E2", rows, { layer: "full" })
  assert.ok(full.includes(skillBody) && full.includes(logText) && full.includes(reportBody), "the full layer keeps everything inline")

  const userHome = formatRow(rows[0].text)
  assert.ok(userHome.includes(skillBody) && userHome.includes(logText))
  assert.ok(!userHome.includes("use the companion skill"), "the user's words stay in the conversation home")
  assert.equal(formatRow(rows[1].text), `[Skill activated: report]\n${reportBody}`)
  assert.equal(formatRow(JSON.stringify({ id: "msg_plain", type: "user", text: "just words" })), "", "a user row without injected content joins no corpus")

  const documents = [
    { id: "E2", text: conversation, layer: "conversation" },
    { id: "msg_user1", text: userHome, layer: "tools" },
    { id: "msg_skill1", text: formatRow(rows[1].text), layer: "tools" },
  ]
  assert.deepEqual(search("directive", documents, 40, "conversation"), [], "skill bodies are not conversation homes")
  assert.deepEqual(search("directive", documents, 40, "full").map((hit) => hit.id), ["msg_user1"])
  assert.equal(search("report skill body", documents, 40, "tools")[0].id, "msg_skill1", "the skill row's own home ranks first for its body")
})

test("formatCatalog is a compact index by default, whole notes on the all view, and drops nothing", () => {
  const entries = [
    { id: "E2", note: "older body" },
    { id: "E10", title: "Recall fixes", start: 1_000, end: 2_000, note: "newest body" },
    { id: "E1", note: "oldest body" },
  ]
  const header = "Archive catalog (newest first) — one entry's note: recall id=catalog E<n>; every note: recall id=catalog all"
  const labeled = `E10 — Recall fixes (${formatSpan(1_000, 2_000)})`
  assert.equal(formatCatalog(entries), [header, labeled, "E2 — (native summary)", "E1 — (native summary)"].join("\n"), "compact: one line per entry, newest first, no note bodies")
  assert.equal(formatCatalog(entries, "all"), [header, `${labeled}\nnewest body`, "E2 — (native summary)\nolder body", "E1 — (native summary)\noldest body"].join("\n\n"), "all: every whole note")
  assert.equal(formatCatalogEntry(entries[1]), `${labeled}\nnewest body`, "an entry fetch is its label and whole note")

  const many = Array.from({ length: 40 }, (_, index) => ({ id: `E${index + 1}`, note: "n".repeat(2_000) }))
  assert.equal(formatCatalog(many).split("\n").length, 41, "every entry gets its line; paging replaces the old drop-oldest tail")
})

test("formatCatalog names allocated-but-never-committed ids as gaps, not corruption", () => {
  const note = (id) => ({ id, note: "body" })
  const gap = (ids) => `Missing ids: ${ids} — allocated but never committed (failed cycles before reservations, or reverted branches)`
  assert.equal(formatCatalog([note("E1"), note("E3")]).split("\n")[1], gap("E2"), "a hole between committed ids names the missing id")
  assert.equal(formatCatalog([note("E1"), note("E3")], "all").split("\n\n")[1], gap("E2"), "the all view carries the same labeled line")
  assert.equal(formatCatalog([note("E1"), note("E3"), note("E5")]).split("\n")[1], gap("E2, E4"), "every hole in range is named")
  assert.equal(formatCatalog([note("E1"), note("E2")]).split("\n")[1], "E2 — (native summary)", "contiguous ids add no line")
  assert.equal(formatCatalog([note("E1")]).split("\n")[1], "E1 — (native summary)", "a single entry cannot show a gap")
  assert.equal(formatCatalog([note("E1"), note("E9")]).split("\n")[1], "E9 — (native summary)", "a range dwarfing the entries reads as non-sequential ids, not gaps")
})

test("parseTarget reads every rendered address and rejects what it cannot mean", () => {
  assert.deepEqual(parseTarget("catalog"), { kind: "catalog" })
  assert.deepEqual(parseTarget("catalog all"), { kind: "catalog", all: true })
  assert.deepEqual(parseTarget("catalog E7"), { kind: "catalog", entry: "E7" })
  assert.deepEqual(parseTarget("catalog E7 page 2"), { kind: "catalog", entry: "E7", page: 2 })
  assert.deepEqual(parseTarget("catalog all page 3"), { kind: "catalog", all: true, page: 3 })
  assert.deepEqual(parseTarget("E57"), { kind: "episode", handle: "E57" })
  assert.deepEqual(parseTarget("id=E57"), { kind: "episode", handle: "E57" }, "a copied field marker is tolerated")
  assert.deepEqual(parseTarget("recall id=E57 layer tools page 2"), { kind: "episode", handle: "E57", layer: "tools", page: 2 }, "so is the whole rendered suggestion")
  assert.deepEqual(parseTarget("E57 layer tools page 2"), { kind: "episode", handle: "E57", layer: "tools", page: 2 })
  assert.deepEqual(parseTarget("call_01HZ2a3"), { kind: "opaque", handle: "call_01HZ2a3" })
  assert.deepEqual(parseTarget("msg_9f page 3"), { kind: "opaque", handle: "msg_9f", page: 3 })
  assert.match(parseTarget("catalog layer full").message, /Cannot parse catalog target near "layer"/)
  assert.match(parseTarget("catalog all E7").message, /one view/)
  assert.match(parseTarget("catalog E7 E8").message, /Cannot parse catalog target near "E8"/)
  assert.match(parseTarget("call_01HZ2a3 layer tools").message, /layer applies only to an episode/)
  assert.match(parseTarget("E57 sideways 2").message, /Cannot parse target near "sideways"/)
  assert.match(parseTarget("").message, /Provide a target/)
  assert.match(parseTarget("E57 page 0").message, /Page must be a positive safe integer/, "a zero page in an address is a client error, not a failure")
  assert.match(parseTarget("catalog E7 page 0").message, /Page must be a positive safe integer/)
  assert.match(parseTarget(`E57 ${"q".repeat(300)}`).message, new RegExp(`near "${"q".repeat(120)}…`), "a pathological token is clipped, not echoed")
})

test("resolveHandle resolves like git: exact, then unique prefix, else ambiguous or unmatched", () => {
  const ids = ["call-1", "call-22", "msg-row"]
  assert.deepEqual(resolveHandle("call-1", ids), { id: "call-1" }, "an exact id wins even when it prefixes another")
  assert.deepEqual(resolveHandle("call-2", ids), { id: "call-22" })
  assert.deepEqual(resolveHandle("msg", ["msg-row", "msg"]), { id: "msg" })
  const ambiguous = resolveHandle("call", ids)
  assert.match(ambiguous.error, /Ambiguous target "call"; candidates: call-1, call-22/)
  assert.match(resolveHandle("nope", ids).error, /No matching episode, tool call, or archived row for "nope". Try a query search by content instead\./)
  const flooded = resolveHandle("z".repeat(500), ids).error
  assert.ok(flooded.length < 250 && flooded.includes(`"${"z".repeat(120)}…"`), "a giant unmatched handle is clipped, not echoed")
})

test("address renders the lean copy-paste target and layers fill only what the address omits", () => {
  assert.equal(address("E57"), "E57")
  assert.equal(address("E57", 2), "E57 page 2")
  assert.equal(address("E57", 2, "conversation"), "E57 page 2", "the default layer is never spelled out")
  assert.equal(address("E57", undefined, "full"), "E57 layer full")
  assert.equal(address("E57", 2, "tools"), "E57 layer tools page 2")
  assert.equal(address("call_01HZ2a3bcdef456"), "call_01HZ2a3bcdef456", "rendered opaque ids are complete, never colliding fixed-length prefixes")
  const parsed = parseTarget(address("E57", 2, "tools"))
  assert.deepEqual(parsed, { kind: "episode", handle: "E57", layer: "tools", page: 2 })
  const opaque = parseTarget(address("call_01HZ2a3bcdef456", 3))
  assert.deepEqual(resolveHandle(opaque.handle, ["call_01HZ2a3bcdef456"]), { id: "call_01HZ2a3bcdef456" }, "every rendered address resolves back to its original")
  for (const layer of LAYERS) assert.ok(parseTarget(address("E57", 1, layer)).kind === "episode")
})

test("formatRow renders the exact tools-layer bytes an opaque row fetch pages through", () => {
  const row = { id: "row-shell-1", type: "shell", command: "node test", output: { output: "rowneedle " + "x ".repeat(4_000) } }
  const rendered = formatRow(JSON.stringify(row))
  assert.ok(rendered.startsWith("[Shell]: node test\nrowneedle "))
  const hit = search("rowneedle", [{ id: "row-shell-1", text: rendered, layer: "tools" }], 10, "tools")[0]
  assert.equal(hit.page, 1)
  assert.equal(paginate(rendered, hit.page).content + paginate(rendered, hit.page + 1).content, rendered, "hit pages join back to the exact fetched bytes")
  const whole = recallPage(shortId("row-shell-1"), rendered)
  assert.ok(whole.endsWith(rendered), "a whole-output fetch returns the exact rendered bytes")
  assert.equal(typeof whole, "string", "text-only rows carry no file parts")
  assert.equal(formatRow("corrupt not json {"), "[Invalid archived row; recall gap]", "a row that cannot parse degrades to the gap marker, not an error")
})

test("archive notes surface only in unfiltered full search", () => {
  const documents = [
    { id: "E1", text: "conversation text", layer: "conversation" },
    { id: "E1#note", note: true, text: "cold archive note with selector keyword" },
    { id: "call-1", text: "tool output home", layer: "tools" },
  ]
  assert.deepEqual(search("selector", documents, 10, "conversation"), [])
  assert.deepEqual(search("selector", documents, 10, "tools"), [])
  const [note] = search("selector", documents, 10, "full")
  assert.equal(note.id, "E1#note")
  assert.equal(note.note, true)
  assert.deepEqual(search("conversation", documents, 10, "conversation").map((hit) => hit.id), ["E1"])
  assert.deepEqual(search("tool output", documents, 10, "tools").map((hit) => hit.id), ["call-1"])
})

test("formatCall marks a recall original's output as an echo, never its input", () => {
  const output = "Historical evidence, page 1\n- recall E1 page 1: quoted original evidence"
  const echoes = []
  const text = formatCall({ id: "call-r", name: "recall", input: { query: "needlequery" }, result: { type: "text", value: output } }, [], echoes)
  assert.equal(echoes.length, 1)
  assert.equal(text.slice(echoes[0][0], echoes[0][1]), output)
  assert.deepEqual(search("Historical", [{ id: "call-r", text, echoes, layer: "tools" }], 10, "tools").map((hit) => hit.id), [], "a re-presentation never ranks")
  assert.deepEqual(search("needlequery", [{ id: "call-r", text, echoes, layer: "tools" }], 10, "tools").map((hit) => hit.id), ["call-r"], "the call input stays findable")
  assert.deepEqual(search("Historical", [{ id: "call-r", text, echoes, layer: "tools" }, { id: "E1", text: "Historical original evidence", layer: "conversation" }], 10, "full").map((hit) => hit.id), ["E1"])
  const plain = []
  formatCall({ id: "call-1", name: "read", input: {}, result: { type: "text", value: output } }, [], plain)
  assert.deepEqual(plain, [], "only recall outputs are echoes")
})

test("a document's boost re-ranks equal matches but never rescues a zero match, and graduated carries onto hits", () => {
  const documents = [
    { id: "E1", text: "needle alpha", graduated: { session: "ses_old", end: 1_000 } },
    { id: "E2", text: "needle beta", boost: 2 },
  ]
  const hits = search("needle", documents)
  assert.deepEqual(hits.map((hit) => hit.id), ["E2", "E1"], "the boosted twin outranks the equal match")
  assert.equal(hits[1].score * 2, hits[0].score)
  assert.deepEqual(hits[1].graduated, { session: "ses_old", end: 1_000 }, "graduated provenance rides the hit")
  assert.deepEqual(search("absent", [{ id: "E3", text: "needle", boost: 100 }]), [], "boost cannot create a match")
})

test("recencyBoost gives fresh notes a small advantage without erasing old relevance", () => {
  const now = Date.now(), day = 24 * 60 * 60 * 1_000
  assert.equal(recencyBoost(now, now), 1)
  assert.ok(Math.abs(recencyBoost(now - 15 * day, now) - 0.95) < 1e-12)
  assert.equal(recencyBoost(now - 30 * day, now), 0.9)
  assert.equal(recencyBoost(now - 40 * day, now), 0.9, "old notes keep a positive floor")
  assert.equal(recencyBoost(now + day, now), 1, "a future end clamps to one")
})

test("formatGraduated renders the provenance header and the whole note text", () => {
  const rendered = formatGraduated({ id: "P7", note: "First\nWork: rotated the secret", session: "ses_0123456789abcdef" })
  assert.equal(rendered, "Graduated session note P7 (from session ses_0123456789abcdef)\nFirst\nWork: rotated the secret")
})

test("rendered opaque IDs and ambiguity candidates remain distinct after their first twelve characters", () => {
  const ids = ["msg_019abcde0000000000000001", "msg_019abcde0000000000000002"]
  assert.notEqual(address(ids[0]), address(ids[1]))
  const ambiguity = resolveHandle(ids[0].slice(0, 12), ids).error
  for (const id of ids) {
    assert.ok(ambiguity.includes(id))
    assert.deepEqual(resolveHandle(parseTarget(address(id, 2)).handle, ids), { id })
  }
})

test("ordinary CJK substrings and mixed identifiers are searchable without whitespace", () => {
  const documents = [
    { id: "E1", text: "認証設定を修正しました。src/auth.tsのOAuth設定も確認。" },
    { id: "E2", text: "데이터베이스연결설정을수정했습니다" },
    { id: "E3", text: "更新数据库连接设置，确认认证流程。𠀀𠀁𠀂" },
  ]
  for (const [query, id] of [["設定", "E1"], ["OAuth", "E1"], ["연결설정", "E2"], ["连接设置", "E3"], ["𠀁𠀂", "E3"]]) {
    const hits = search(query, documents)
    assert.equal(hits[0].id, id, query)
    assert.ok(hits[0].snippet.isWellFormed(), query)
  }
})

test("unsafe page integers and huge sparse catalog ranges are rejected before allocation", () => {
  for (const page of ["9007199254740992", "9".repeat(400)]) {
    assert.match(parseTarget(`E1 page ${page}`).message, /positive safe integer/)
    assert.match(parseTarget(`catalog page ${page}`).message, /positive safe integer/)
  }
  for (const page of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5, 0, -1]) {
    assert.throws(() => paginate("text", page), /Invalid/)
    assert.throws(() => recallPage("E1", "text", page), /Invalid/)
  }
  const rendered = formatCatalog([{ id: "E1", note: "one" }, { id: `E${Number.MAX_SAFE_INTEGER}`, note: "far away" }])
  assert.doesNotMatch(rendered, /Missing ids/)
  assert.ok(rendered.length < 500)
})

test("old-note ranking still follows relevance rather than ID order after thirty days", () => {
  const now = 100 * 86_400_000
  const documents = [
    { id: "P1", text: "unrelated background needle", boost: recencyBoost(1, now) },
    { id: "P99", text: "needle needle exact_error", boost: recencyBoost(1, now) },
  ]
  const hits = search("needle exact_error", documents)
  assert.equal(hits[0].id, "P99")
  assert.ok(hits.every((hit) => hit.score > 0))
})

test("an exact phrase outranks frequent generic words without hiding broader lexical matches", () => {
  const documents = [
    { id: "bag", text: "session this in very ".repeat(80) },
    { id: "phrase", text: "The user said: In this very session, verify the release." },
    { id: "partial", text: "this session has a different purpose" },
  ]
  for (const query of ["In this very session", '"In this very session"']) {
    const hits = search(query, documents)
    assert.equal(hits[0].id, "phrase", query)
    assert.ok(hits.some((hit) => hit.id === "bag"), "ranking preference is not a silent hard filter")
    assert.ok(hits.some((hit) => hit.id === "partial"))
  }
})

test("compact query coverage outranks scattered equal-frequency words", () => {
  const filler = "neutral ".repeat(70)
  const hits = search("capacity gate reserve", [
    { id: "scattered", text: `capacity ${filler}gate ${filler}reserve` },
    { id: "near", text: `capacity has a gate with reserve ${filler}${filler}` },
  ])
  assert.equal(hits[0].id, "near")
  assert.ok(hits[0].score > hits[1].score)
})

test("exact structured identifiers prefer punctuation and whole tokens, not component bags or suffixes", () => {
  const hits = search("src/auth.ts ERROR_401 requestCompact", [
    { id: "components", text: "src auth ts ERROR_401 requestCompact ".repeat(50) },
    { id: "suffix", text: "src/auth.tsx ERROR_4019 requestCompactLater" },
    { id: "exact", text: "Fixed src/auth.ts after ERROR_401 in requestCompact." },
  ])
  assert.equal(hits[0].id, "exact")
  assert.ok(hits.some((hit) => hit.id === "components"), "component keywords still recall potentially useful evidence")
  assert.deepEqual(search("ERROR_401", [{ id: "suffix", text: "ERROR_4019" }]), [], "whole identifiers never become substring matches")
  const path = search("src/auth.ts", [{ id: "spaces", text: "src auth ts" }, { id: "path", text: "src/auth.ts" }])
  assert.equal(path[0].id, "path")
})

test("quoted subphrases and normalized Unicode identifiers retain original snippet offsets", () => {
  const exact = `😀 ${"padding ".repeat(120)}A CAFE\u0301\nreport in src/cafe\u0301.ts fixes the ceiling.`
  const documents = [
    { id: "reordered", text: "report café ceiling src café ts ".repeat(40) },
    { id: "exact", text: exact },
  ]
  const [hit] = search('ceiling "café report" src/café.ts', documents)
  assert.equal(hit.id, "exact")
  assert.match(hit.snippet, /CAFE\u0301 report/)
  assert.ok(hit.snippet.isWellFormed())
  assert.ok(paginate(exact, hit.page).content.includes("src/cafe\u0301.ts"))
})

test("phrase preference never bridges a recall echo and centers a genuine later phrase", () => {
  const echoed = "budget gate reserve ".repeat(40)
  const text = `budget ${echoed}gate reserve\n${"plain ".repeat(170)}budget gate reserve is the genuine conclusion`
  const [hit] = search('"budget gate reserve"', [{ id: "E1", text, echoes: [[7, 7 + echoed.length]] }])
  assert.match(hit.snippet, /genuine conclusion/)
  assert.doesNotMatch(hit.snippet, /budget gate reserve budget gate reserve/)
  assert.deepEqual(search('"budget gate reserve"', [{ id: "echo", text: echoed, echoes: [[0, echoed.length]] }]), [])
})
