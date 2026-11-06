// The note format, version 1. One thought, one note.
//
// ⚠️ THIS IS A CONTRACT WITH THE APP. The ThoughtFree app writes the same notes
// into its vault ZIP (lib/core/export/vault_note.dart there), so both render
// fixtures/notes.json and must produce exactly what it says. Change the format
// only by raising NOTE_FORMAT and changing both sides.
//
// Pure, with no Obsidian import, so it runs under `node --test`.

export const NOTE_FORMAT = 1;

export type FeedFile = {
  id: string;
  kind: "image" | "pdf" | "audio";
  mime: string | null;
  name: string | null;
  size: number | null;
  url: string;
};

export type FeedComment = { id: string; content: string; created_at: string };

export type FeedNote = {
  id: string;
  state: "live" | "archived" | "trashed" | "gone";
  kind?: "event" | "task" | "note";
  title?: string | null;
  content?: string;
  type?: string;
  category?: string | null;
  tags?: string[];
  starred?: boolean;
  priority?: string | null;
  status?: string | null;
  due_date?: string | null;
  completed_at?: string | null;
  event_start?: string | null;
  event_end?: string | null;
  event_all_day?: boolean;
  event_location?: string | null;
  link_url?: string | null;
  created_at?: string;
  updated_at?: string;
  comments?: FeedComment[];
  files?: FeedFile[];
};

export type FeedCategory = { key: string; label: string; emoji?: string };

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
const NOT_IN_A_NAME = /[\\/:*?"<>|#^[\]]/g;
const MAX_NAME = 60;

/** Code points, so an emoji is never cut in half. */
function clip(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/**
 * One path segment that every platform accepts and that cannot climb out of
 * its folder. ⚠️ A category's name and a thought's words end up here, and
 * neither is ours: this is what stands between them and a path.
 */
export function safeSegment(raw: string, fallback: string): string {
  const printable = Array.from(raw.normalize("NFC"), (c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? " " : c;
  }).join("");
  const cleaned = printable
    .replace(NOT_IN_A_NAME, " ")
    .replace(/\s+/g, " ")
    .trim();
  let name = clip(cleaned, MAX_NAME).replace(/[. ]+$/g, "").replace(/^[. ]+/g, "");
  if (!name) return fallback;
  if (RESERVED.test(name)) name = `${name} note`;
  return name;
}

/** A vault folder a person typed: each segment made safe, `..` gone. */
export function safeFolder(raw: string, fallback: string): string {
  const parts = raw
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..")
    .map((p) => safeSegment(p, ""))
    .filter(Boolean);
  return parts.length ? parts.join("/") : fallback;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** What names the note: the title, or the first line of the words. */
export function headline(note: FeedNote): string {
  const title = oneLine(note.title ?? "");
  if (title) return title;
  const first = (note.content ?? "").split("\n").find((l) => l.trim()) ?? "";
  return oneLine(first.replace(/^[#>\s*-]+/, ""));
}

/**
 * The note's file name. The id is what makes two devices sharing a vault
 * arrive at the same file, so it is part of the name, always, and a title
 * changed later does not rename anything.
 */
export function noteFileName(note: FeedNote): string {
  return `${safeSegment(headline(note), "Thought")} ${note.id.slice(0, 6)}.md`;
}

export function categoryLabel(
  key: string | null | undefined,
  categories: readonly FeedCategory[],
): string {
  if (!key) return "Uncategorized";
  return categories.find((c) => c.key === key)?.label ?? key;
}

const INERT_FENCES = new Set([
  "", "text", "txt", "plain", "markdown", "md", "json", "yaml", "yml", "toml", "xml", "html",
  "css", "scss", "js", "javascript", "jsx", "ts", "typescript", "tsx", "python", "py", "bash",
  "sh", "shell", "zsh", "powershell", "sql", "go", "rust", "java", "kotlin", "swift", "dart",
  "c", "cpp", "csharp", "cs", "php", "ruby", "diff",
]);

/** Same line in a quote, a list or a numbered item is still a fence. */
const FENCE = /^([ \t>*+\-0-9.)]*)(`{3,}|~{3,})[ \t]*([^\n]*)$/gm;

/**
 * Words are data, and a vault is a place where words can run.
 *
 * ⚠️ A thought can hold a clipped web page, so its text is not necessarily the
 * person's own. A `dataviewjs` block runs as code in a vault with that plugin
 * on; `$=` is the same thing inline, and Dataview reads it in any code element;
 * Templater runs `<% %>`. A remote image or a tag with a URL tells a stranger's
 * server someone opened the note.
 *
 * Patterns for the bad cases lose to Markdown's many spellings, so the ways in
 * are closed instead: a zero-width space after every `<` that could open a tag
 * and every `!` that could start an image, and before `$=`. The text reads the
 * same, in code too, and is simply never parsed as a tag or an embed.
 */
export function defang(text: string): string {
  return text
    .replace(FENCE, (line, prefix: string, fence: string, info: string) => {
      const language = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      return INERT_FENCES.has(language) ? line : `${prefix}${fence}text`;
    })
    .replace(/`(\s*)(\$?=)/g, "`$1\u200b$2")
    .replace(/^(\s*)\$=/gm, "$1\u200b$=")
    .replace(/<(?=[A-Za-z/!?%])/g, "<\u200b")
    .replace(/!\[/g, "!\u200b[");
}

/** A tag Obsidian accepts: no spaces, no marks, not only digits. */
export function safeTag(raw: string): string | null {
  const t = raw.normalize("NFC").trim().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_\-/]/gu, "");
  if (!t) return null;
  return /^[0-9/_-]+$/.test(t) ? `t-${t}` : t;
}

function isoSeconds(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * Line endings and the end of the file settle to one form before comparing, so
 * an editor that adds a final newline does not read as a person's edit.
 */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\s+$/g, "").replace(/^\n+/, "");
}

/** FNV-1a, 64 bit, over UTF-8. A change detector, not a secret: it says whether
 * the words are still the ones we wrote. */
export function fingerprint(body: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(normalizeBody(body))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function isDone(note: FeedNote): boolean {
  return !!note.completed_at || note.status === "done";
}

/** The name a fetched file gets: ours, from its id and type, never its own. */
export function fileNameFor(file: Pick<FeedFile, "id" | "kind" | "mime">): string {
  const id = file.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36) || "file";
  const ext = FILE_EXTENSIONS[file.mime ?? ""] ??
    (file.kind === "pdf" ? "pdf" : file.kind === "audio" ? "m4a" : "webp");
  return `${id}.${ext}`;
}

const FILE_EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
};

/** The body of a note. [embeds] are the vault paths of its fetched files. */
export function renderBody(note: FeedNote, embeds: readonly string[] = []): string {
  const parts: string[] = [];
  const title = oneLine(note.title ?? "");
  if (title) parts.push(`# ${defang(title)}`);

  const words = defang((note.content ?? "").trim());
  if (note.kind === "task") {
    const [first = "", ...rest] = words.split("\n");
    const box = `- [${isDone(note) ? "x" : " "}] ${first}`;
    parts.push([box, ...rest.map((l) => (l ? `    ${l}` : ""))].join("\n"));
  } else if (words) {
    parts.push(words);
  }

  if (embeds.length) parts.push(embeds.map((p) => `![[${p}]]`).join("\n"));

  const comments = note.comments ?? [];
  if (comments.length) {
    parts.push("## Comments");
    parts.push(comments.map((c) => `- ${defang(oneLine(c.content))}`).join("\n"));
  }
  return parts.join("\n\n");
}

/** The properties, in their order. Null is left out. */
export function properties(
  note: FeedNote,
  categories: readonly FeedCategory[],
): Record<string, string | string[] | number | boolean> {
  const out: Record<string, string | string[] | number | boolean> = {
    thoughtfree_id: note.id,
    thoughtfree_format: NOTE_FORMAT,
    thoughtfree_state: note.state,
    thoughtfree_category: note.category ?? "",
    category: categoryLabel(note.category, categories),
    kind: note.kind ?? "note",
  };
  const tags = [...new Set((note.tags ?? []).map(safeTag).filter((t): t is string => !!t))];
  if (tags.length) out.tags = tags;
  const put = (key: string, value: string | null) => {
    if (value) out[key] = value;
  };
  put("created", isoSeconds(note.created_at));
  put("updated", isoSeconds(note.updated_at));
  put("due", note.due_date ? note.due_date.slice(0, 10) : null);
  put("done", isoSeconds(note.completed_at));
  put("event_start", isoSeconds(note.event_start));
  put("event_end", isoSeconds(note.event_end));
  put("location", note.event_location ? oneLine(note.event_location) : null);
  put("priority", note.priority ?? null);
  if (note.starred) out.starred = true;
  put("link", note.link_url ?? null);
  out.source = `https://app.thoughtfree.io/thought/${note.id}`;
  return out;
}

/** The properties a sync owns and a person can change. The state is left out:
 * it moves with Trash, and is never a person's edit. */
export const MANAGED_PROPERTIES = [
  "thoughtfree_category", "category", "kind", "tags", "created", "updated", "due", "done",
  "event_start", "event_end", "location", "priority", "starred", "link", "source",
];

/** What the properties were when we wrote them, so that a tag added in Obsidian
 * reads as a person's edit, as a changed word does. */
export function propertiesPrint(props: Record<string, unknown>): string {
  const held = MANAGED_PROPERTIES.flatMap((key) =>
    props[key] === undefined || props[key] === null ? [] : [[key, props[key]]],
  );
  return fingerprint(JSON.stringify(held));
}

/** ⚠️ Every string is JSON-quoted, which is valid YAML, so nothing in a title
 * or a tag can end the block or add a key of its own. `<` is written as an
 * escape, because Templater reads a new file's properties too. */
function yamlValue(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderFrontmatter(props: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(props)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlValue(item)}`);
    } else {
      lines.push(`${key}: ${yamlValue(value)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** A whole new note. */
export function renderNote(
  note: FeedNote,
  categories: readonly FeedCategory[],
  embeds: readonly string[] = [],
): string {
  const body = renderBody(note, embeds);
  const props = properties(note, categories);
  const stamped = {
    ...props,
    thoughtfree_hash: fingerprint(body),
    thoughtfree_props: propertiesPrint(props),
  };
  return `${renderFrontmatter(stamped)}${body}\n`;
}

/** A note's text, split at its properties. */
export function splitNote(text: string): { frontmatter: string; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n[\s\S]*?\n---\n?/.exec(normalized);
  return match
    ? { frontmatter: match[0], body: normalized.slice(match[0].length) }
    : { frontmatter: "", body: normalized };
}

/** [frontmatter] with its two stamps set, so they move in one write with the
 * words they describe. */
export function stampFrontmatter(frontmatter: string, hash: string, print: string): string {
  const lines = frontmatter.split("\n").filter(
    (l) => !l.startsWith("thoughtfree_hash:") && !l.startsWith("thoughtfree_props:"),
  );
  const close = lines.lastIndexOf("---");
  lines.splice(close, 0, `thoughtfree_hash: ${JSON.stringify(hash)}`, `thoughtfree_props: ${JSON.stringify(print)}`);
  return lines.join("\n");
}

/** The fetched files a note's words already embed under [folder]. */
export function embedsIn(body: string, folder: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(/!\[\[([^\]\n]+)\]\]/g)) {
    if (m[1]?.startsWith(`${folder}/`)) found.push(m[1]);
  }
  return found;
}
