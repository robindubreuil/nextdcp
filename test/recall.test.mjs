import assert from "node:assert/strict"
import test from "node:test"
import { formatCall, formatTranscript, recallPage, paginate, search, RECALL_ALL_CHARS, RECALL_PAGE_CHARS } from "../src/recall.ts"

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
  const [note] = search("selector", [{ id: "E3", text: "The raw transcript uses other words.", summary: "Compaction model selector; src/picker.ts." }])
  assert.equal(note.note, true)
  assert.equal(note.page, 1)
  assert.match(note.snippet, /selector/)
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
  assert.match(whole, /^recall \{"id":"call-1"\} \(whole output\)\n/)
  assert.ok(whole.endsWith(small))
  const big = "b".repeat(RECALL_PAGE_CHARS * 7) + "😀 tail"
  const head = recallPage("call-2", big)
  const body = head.slice(head.indexOf("\n") + 1)
  assert.match(head, /^recall \{"id":"call-2","page":6\} \(whole output too large: first 30000 of 42007 characters; continue at page 6\)\n/)
  assert.equal(body, big.slice(0, RECALL_ALL_CHARS))
  const rest = Array.from({ length: 3 }, (_, index) => paginate(big, index + 6).content).join("")
  assert.equal(body + rest, big)
  assert.equal(recallPage("empty", ""), 'recall {"id":"empty"} (whole output)\n')
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
  const transcript = formatTranscript("E3", [...rows.map((row) => ({ id: row.id, text: JSON.stringify(row) })), { id: "missing-secret" }], true)
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
  assert.throws(() => recallPage("media", text, 3, files), /between/)
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
  const text = formatTranscript("E1", [{ id: "u", text: JSON.stringify(input) }], false, files)
  const result = recallPage("E1", text, 1, files)
  assert.deepEqual(result.slice(1).map((file) => file.uri), ["data:image/png;base64,AAAA", "data:application/pdf;base64,BBBB"])
  assert.match(result[0].text, /searchable café/)
  assert.doesNotMatch(result[0].text, /AAAA|BBBB|base64/)
  assert.equal(search("searchable", [{ id: "E1", text }]).length, 1)
})
