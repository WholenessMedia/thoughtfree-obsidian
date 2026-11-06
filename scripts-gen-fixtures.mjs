// Regenerates fixtures/notes.json from src/format.ts. Run after a deliberate
// format change, and copy the file to the app's test/fixtures/.
import { writeFileSync } from "node:fs";
import { noteFileName, renderNote } from "./src/format.ts";

const categories = [
  { key: "ideas", label: "Ideas" },
  { key: "books", label: "Books / Films" },
];
const base = {
  state: "live",
  kind: "note",
  content: "A plain thought.",
  category: "ideas",
  created_at: "2026-11-05T09:30:00.123+00:00",
  updated_at: "2026-11-05T10:00:00+00:00",
};
const cases = [
  ["a plain thought", { ...base, id: "11111111-1111-4111-8111-111111111111" }],
  ["a title", { ...base, id: "22222222-2222-4222-8222-222222222222", title: "Mano mintis: šiandien" }],
  ["no category", { ...base, id: "33333333-3333-4333-8333-333333333333", category: null }],
  ["a deleted category", { ...base, id: "44444444-4444-4444-8444-444444444444", category: "old-key" }],
  ["tags", { ...base, id: "55555555-5555-4555-8555-555555555555", tags: ["two words", "2026", "ok", "ok"] }],
  ["an open task", { ...base, id: "66666666-6666-4666-8666-666666666666", kind: "task", content: "Buy milk\n\nsemi-skimmed", due_date: "2026-11-07", priority: "high" }],
  ["a done task", { ...base, id: "77777777-7777-4777-8777-777777777777", kind: "task", content: "Call Jonas", completed_at: "2026-11-05T12:00:00Z" }],
  ["an event", { ...base, id: "88888888-8888-4888-8888-888888888888", kind: "event", content: "Lunch", event_start: "2026-11-06T12:00:00Z", event_end: "2026-11-06T13:00:00+00:00", event_location: "Vilnius" }],
  ["comments", { ...base, id: "99999999-9999-4999-8999-999999999999", starred: true, comments: [{ id: "c1", content: "first\nreply", created_at: "2026-11-05T10:00:00Z" }] }],
  ["hostile words", { ...base, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: '../../x: "y"', content: "```dataviewjs\ndv.x()\n```\n\n`$= 1`\n\n<% x %>\n\n![p](https://e.example/p.png)\n\n<iframe src=x>" }],
  ["an archived link", { ...base, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "archived", type: "link", link_url: "https://example.com/a", content: "" }],
].map(([name, note]) => ({ name, note, fileName: noteFileName(note), text: renderNote(note, categories) }));

writeFileSync("fixtures/notes.json", `${JSON.stringify({ format: 1, categories, cases }, null, 2)}\n`);
