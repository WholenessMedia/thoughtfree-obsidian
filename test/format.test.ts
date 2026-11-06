import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MANAGED_PROPERTIES,
  defang,
  embedsIn,
  fileNameFor,
  fingerprint,
  noteFileName,
  normalizeBody,
  properties,
  renderBody,
  renderFrontmatter,
  renderNote,
  safeFolder,
  safeSegment,
  safeTag,
  splitNote,
  type FeedNote,
} from "../src/format.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/notes.json", import.meta.url), "utf8"));

test("every fixture renders exactly as written (the contract with the app)", () => {
  for (const c of fixture.cases) {
    assert.equal(noteFileName(c.note), c.fileName, c.name);
    assert.equal(renderNote(c.note, fixture.categories), c.text, c.name);
  }
});

test("a name cannot climb out of its folder", () => {
  for (const raw of ["../../etc/passwd", "..", ".", "a/b\\c", "..\\..\\x", "/abs", "C:\\x"]) {
    const name = safeSegment(raw, "Thought");
    assert.equal(name.includes("/"), false, raw);
    assert.equal(name.includes("\\"), false, raw);
    assert.equal(name.startsWith("."), false, raw);
  }
  assert.equal(safeFolder("../../secret/./notes", "root"), "secret/notes");
  assert.equal(safeFolder("..", "root"), "root");
  assert.equal(safeFolder("", "root"), "root");
});

test("a name works on every platform", () => {
  assert.equal(safeSegment("CON", "x"), "CON note");
  assert.equal(safeSegment("NUL.txt", "x"), "NUL.txt note");
  assert.equal(safeSegment("COM¹", "x"), "COM¹ note");
  assert.equal(safeSegment("name. . ", "x"), "name");
  assert.equal(safeSegment('a:b*c?"d<e>f|g', "x"), "a b c d e f g");
  assert.equal(safeSegment("   ", "x"), "x");
  assert.equal(Array.from(safeSegment("😀".repeat(100), "x")).length, 60);
  assert.equal(safeSegment("😀".repeat(100), "x").endsWith("\ud83d"), false);
  assert.equal(safeSegment("Škėmė lietuviškai", "x"), "Škėmė lietuviškai");
});

test("the id is always in the name, so two devices reach one file", () => {
  const note: FeedNote = { id: "abcdef123456", state: "live", title: "Same", content: "" };
  assert.equal(noteFileName(note), "Same abcdef.md");
  assert.equal(noteFileName({ ...note, title: "", content: "\n\n  # A heading\nmore" }), "A heading abcdef.md");
  assert.equal(noteFileName({ ...note, title: null, content: "" }), "Thought abcdef.md");
});

test("what could run is written so it cannot", () => {
  assert.equal(defang("```dataviewjs\ndv.page()\n```"), "```text\ndv.page()\n```");
  assert.equal(defang("~~~dataview\nTABLE\n~~~"), "~~~text\nTABLE\n~~~");
  assert.equal(defang("```JS-Engine run\nx\n```"), "```text\nx\n```");
  // Fences in a quote, a list and with a backtick in the info line.
  assert.equal(defang("> ```dataviewjs\n> x\n> ```").includes("dataviewjs"), false);
  assert.equal(defang("- ```dataviewjs\n  x").includes("dataviewjs"), false);
  assert.equal(defang("1. ~~~dataviewjs\n  x").includes("dataviewjs"), false);
  assert.equal(defang("~~~dataviewjs `x`\nx").includes("dataviewjs"), false);
  assert.ok(!/`\$=/.test(defang("a `$= dv.current()` b")));
  assert.ok(!/`\s*\$=/.test(defang("a ` $= x` b")));
  assert.ok(!/`=/.test(defang("a `= this.x` b")));
  // Dataview reads `$=` in any code element, a fenced or indented block too.
  assert.ok(!/^\s*\$=/m.test(defang("```\n$= dv.x()\n```")));
  assert.ok(!/^\s*\$=/m.test(defang("    $= dv.x()")));
  assert.equal(defang("<code>$= x</code>").includes("<code"), false);
  assert.equal(defang("<% tp.user.evil() %>").includes("<%"), false);
});

test("what could phone home is written so it does not", () => {
  for (const image of [
    "![pixel](https://evil.example/p.png)",
    '![x](http://e.example/a "title")',
    "![a [b] c](https://e.example/p)",
    "![a](<https://e.example/p>)",
    "![a][r]\n\n[r]: https://e.example/p",
    "![line\nbreak](https://e.example/p)",
  ]) {
    assert.equal(defang(image).includes("!["), false, image);
  }
  for (const tag of [
    "<img src=x>", "<iframe src=x>", "<IMG src=x>", "<svg onload=x>", "<script>x</script>",
    "<image src=x>", "<input type=image src=x>", "<table background=x>",
    '<div style="background:url(http://e.example)">', "<!-- x -->", "</x>",
  ]) {
    assert.equal(/<[A-Za-z/!?]/.test(defang(tag)), false, tag);
  }
});

test("words and code still read the same", () => {
  const words = "# Heading\n\n```python\nprint(1)\n```\n\n[a link](https://x.example)\n\n1 < 2";
  assert.equal(defang(words), words);
  assert.equal(defang("<b>bold</b>").replaceAll("\u200b", ""), "<b>bold</b>");
});

test("a tag is one Obsidian accepts", () => {
  assert.equal(safeTag("#two words"), "two-words");
  assert.equal(safeTag("mažas"), "mažas");
  assert.equal(safeTag("2026"), "t-2026");
  assert.equal(safeTag("  "), null);
  assert.equal(safeTag("a.b,c"), "abc");
});

test("nothing in a value can end the properties or add one", () => {
  const text = renderFrontmatter({ category: 'x"\n---\nevil: true', tags: ['a"\nb: c'] });
  const lines = text.split("\n");
  assert.equal(lines.filter((l) => l === "---").length, 2);
  assert.equal(lines.some((l) => l.startsWith("evil:")), false);
  assert.equal(lines.some((l) => l.startsWith("b:")), false);
});

test("no value can hand Templater anything", () => {
  const text = renderFrontmatter({ location: "<% tp.user.evil() %>", tags: ["<%x%>"] });
  assert.equal(text.includes("<%"), false);
  assert.ok(text.includes("\\u003c%"));
});

test("a title cannot start the properties over", () => {
  const { frontmatter, body } = splitNote(renderNote(
    { id: "abcdef", state: "live", content: "---\nthoughtfree_id: other\n---\nwords" },
    [],
  ));
  assert.ok(frontmatter.includes('thoughtfree_id: "abcdef"'));
  assert.ok(body.includes("words"));
});

test("a saved file compares equal to what was written", () => {
  const note: FeedNote = { id: "abcdef", state: "live", content: "words\n\nmore" };
  const body = renderBody(note);
  assert.equal(fingerprint(`${body}\n`), fingerprint(body));
  assert.equal(fingerprint(`${body}\r\n\r\n`), fingerprint(body));
  assert.equal(fingerprint(body.replace("\n", "\r\n")), fingerprint(body));
  assert.notEqual(fingerprint(`${body}!`), fingerprint(body));
  assert.equal(normalizeBody("\n\nx\n"), "x");
});

test("the fingerprint matches the known FNV-1a values", () => {
  assert.equal(fingerprint(""), "cbf29ce484222325");
  assert.equal(fingerprint("a"), "af63dc4c8601ec8c");
});

test("a fetched file is named by us", () => {
  assert.equal(fileNameFor({ id: "a1", kind: "image", mime: "image/png" }), "a1.png");
  assert.equal(fileNameFor({ id: "../../x", kind: "pdf", mime: null }), "x.pdf");
  assert.equal(fileNameFor({ id: "a1", kind: "audio", mime: "audio/mp4" }), "a1.m4a");
});

test("embeds are found by their folder", () => {
  assert.deepEqual(embedsIn("x ![[R/attachments/a.m4a]] ![[other/b.png]]", "R/attachments"), ["R/attachments/a.m4a"]);
});

test("every property a sync writes and a person can change is in the print", () => {
  const props = properties({ id: "abcdef", state: "live", due_date: "2026-11-07", tags: ["a"], starred: true,
    event_start: "2026-11-07T09:00:00Z", event_end: "2026-11-07T10:00:00Z", event_location: "x", priority: "high",
    link_url: "https://x.example", completed_at: "2026-11-07T09:00:00Z", created_at: "2026-11-07T09:00:00Z",
    updated_at: "2026-11-07T09:00:00Z" }, []);
  const notManaged = Object.keys(props).filter((k) => !MANAGED_PROPERTIES.includes(k));
  assert.deepEqual(notManaged.sort(), ["thoughtfree_format", "thoughtfree_id", "thoughtfree_state"]);
});

test("a task is a checkbox, open or done", () => {
  const task: FeedNote = { id: "abcdef", state: "live", kind: "task", content: "Buy milk\nsemi-skimmed" };
  assert.equal(renderBody(task), "- [ ] Buy milk\n    semi-skimmed");
  assert.equal(renderBody({ ...task, completed_at: "2026-11-05T09:00:00Z" }).startsWith("- [x]"), true);
});

test("comments and files have their place", () => {
  const note: FeedNote = {
    id: "abcdef",
    state: "live",
    content: "words",
    comments: [{ id: "c", content: "a reply\non two lines", created_at: "x" }],
  };
  assert.equal(renderBody(note, ["ThoughtFree/attachments/a.png"]),
    "words\n\n![[ThoughtFree/attachments/a.png]]\n\n## Comments\n\n- a reply on two lines");
});
