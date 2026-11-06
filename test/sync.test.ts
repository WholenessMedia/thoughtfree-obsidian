import assert from "node:assert/strict";
import { test } from "node:test";
import { baseFile, folderFor, notePath, Sync, type SyncConfig, type SyncMemory } from "../src/sync.ts";
import { fingerprint, splitNote, type FeedNote } from "../src/format.ts";
import type { FeedPage } from "../src/feed.ts";
import { FeedStop } from "../src/feed.ts";
import { FakeVault, jsonResponse } from "./fake.ts";
import type { Http } from "../src/http.ts";

const ACCOUNT = "account-1";
const CATEGORIES = [
  { key: "ideas", label: "Ideas" },
  { key: "health", label: "Health" },
];

const config = (extra: Partial<SyncConfig> = {}): SyncConfig => ({
  root: "ThoughtFree",
  folders: {},
  attachments: true,
  ...extra,
});

const fresh = (): SyncMemory => ({ cursor: "0", account: null, categories: [] });

const thought = (id: string, extra: Partial<FeedNote> = {}): FeedNote => ({
  id,
  state: "live",
  kind: "note",
  title: null,
  content: `words of ${id}`,
  category: "ideas",
  created_at: "2026-11-05T09:00:00Z",
  updated_at: "2026-11-05T09:00:00Z",
  ...extra,
});

/** A feed that serves [pages] in turn, one page per cursor. */
function feed(pages: Array<Partial<FeedPage> & { notes: FeedNote[] }>, seen?: string[]): Http {
  return async (req) => {
    const after = Number(new URL(req.url).searchParams.get("after"));
    seen?.push(String(after));
    const page = pages[after];
    if (!page) return jsonResponse(200, { version: 1, account: ACCOUNT, notes: [], categories: CATEGORIES, next: String(after), more: false, remaining: 0 });
    return jsonResponse(200, {
      version: 1,
      account: ACCOUNT,
      categories: CATEGORIES,
      next: String(after + 1),
      more: after + 1 < pages.length,
      remaining: pages.length - after - 1,
      ...page,
    });
  };
}

const token = { get: async () => "t", renew: async () => "t2" };

async function run(vault: FakeVault, http: Http, memory = fresh(), cfg = config()) {
  let last = memory;
  const sync = new Sync(vault, http, token, "https://feed.example/changes", "1.0.0");
  const result = await sync.run(cfg, memory, async (m) => {
    last = m;
  });
  return { result, memory: last };
}

const pathOf = (vault: FakeVault, id: string) => vault.indexNotes().get(id)?.path;

test("a thought lands in its category's folder", async () => {
  const vault = new FakeVault();
  const { result } = await run(vault, feed([{ notes: [thought("aaaaaa-1")] }]));
  assert.equal(result.created, 1);
  assert.equal(pathOf(vault, "aaaaaa-1"), "ThoughtFree/Ideas/words of aaaaaa-1 aaaaaa.md");
});

test("a category can be sent to any folder, or skipped", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1"), thought("bbbbbb-1", { category: "health" })] }]), fresh(),
    config({ folders: { ideas: { folder: "Areas/Thinking" }, health: { skip: true } } }));
  assert.equal(pathOf(vault, "aaaaaa-1"), "Areas/Thinking/words of aaaaaa-1 aaaaaa.md");
  assert.equal(pathOf(vault, "bbbbbb-1"), undefined);
});

test("a typed folder cannot leave the vault", () => {
  const cfg = config({ folders: { ideas: { folder: "../../outside" } } });
  assert.equal(folderFor("ideas", CATEGORIES, cfg), "outside");
});

test("a hostile title stays inside its folder", () => {
  const path = notePath(thought("aaaaaa-1", { title: "../../../etc/passwd" }), CATEGORIES, config());
  assert.ok(path.startsWith("ThoughtFree/Ideas/"));
  assert.equal(path.includes(".."), false);
});

test("a hostile category name stays inside the root", () => {
  const path = notePath(thought("aaaaaa-1", { category: "x" }),
    [{ key: "x", label: "../../outside" }], config());
  assert.ok(path.startsWith("ThoughtFree/"));
  assert.equal(path.includes(".."), false);
});

test("no category is Uncategorized", () => {
  assert.equal(folderFor(null, CATEGORIES, config()), "ThoughtFree/Uncategorized");
});

test("the same page twice changes nothing and duplicates nothing", async () => {
  const vault = new FakeVault();
  const pages = [{ notes: [thought("aaaaaa-1")] }];
  await run(vault, feed(pages));
  const before = [...vault.files.entries()];
  const { result } = await run(vault, feed(pages));
  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
  assert.deepEqual([...vault.files.keys()], before.map(([k]) => k));
});

test("an edit in the app reaches an untouched note", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1")] }]));
  const { result } = await run(vault, feed([{ notes: [thought("aaaaaa-1", { content: "new words" })] }]));
  assert.equal(result.updated, 1);
  const path = pathOf(vault, "aaaaaa-1")!;
  assert.ok(vault.files.get(path)!.includes("new words"));
  assert.equal(vault.indexNotes().get("aaaaaa-1")!.hash, fingerprint("new words"));
  assert.ok(vault.files.get(path)!.includes("thoughtfree_props:"));
});

test("a person's edit is never overwritten", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1")] }]));
  const path = pathOf(vault, "aaaaaa-1")!;
  vault.files.set(path, vault.files.get(path)!.replace("words of aaaaaa-1", "my own better words"));
  const { result } = await run(vault, feed([{ notes: [thought("aaaaaa-1", { content: "from the app" })] }]));
  assert.equal(result.kept, 1);
  assert.equal(result.updated, 0);
  const text = vault.files.get(path)!;
  assert.ok(text.includes("my own better words"));
  assert.equal(text.includes("from the app"), false);
});

test("a person's own properties survive an update", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1")] }]));
  const path = pathOf(vault, "aaaaaa-1")!;
  await vault.setProperties(path, { rating: 5 });
  await run(vault, feed([{ notes: [thought("aaaaaa-1", { content: "new words" })] }]));
  assert.ok(splitNote(vault.files.get(path)!).frontmatter.includes("rating: 5"));
});

test("a tag a person added counts as their edit", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1", { tags: ["app"] })] }]));
  const path = pathOf(vault, "aaaaaa-1")!;
  await vault.setProperties(path, { tags: ["app", "mine"] });
  const { result } = await run(vault, feed([{ notes: [thought("aaaaaa-1", { tags: ["app"], content: "new words" })] }]));
  assert.equal(result.kept, 1);
  const text = vault.files.get(path)!;
  assert.ok(text.includes("mine"));
  assert.equal(text.includes("new words"), false);
});

test("a date cleared in the app leaves the note", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1", { kind: "task", due_date: "2026-11-09", starred: true })] }]));
  await run(vault, feed([{ notes: [thought("aaaaaa-1", { kind: "task" })] }]));
  const { frontmatter } = splitNote(vault.files.get(pathOf(vault, "aaaaaa-1")!)!);
  assert.equal(frontmatter.includes("due:"), false);
  assert.equal(frontmatter.includes("starred:"), false);
});

test("words typed during the write are kept", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1")] }]));
  const path = pathOf(vault, "aaaaaa-1")!;
  vault.beforeWrite = () => vault.files.set(path, vault.files.get(path)!.replace("words of", "typed just now,"));
  const { result } = await run(vault, feed([{ notes: [thought("aaaaaa-1", { content: "from the app" })] }]));
  vault.beforeWrite = null;
  assert.equal(result.updated, 0);
  assert.ok(vault.files.get(path)!.includes("typed just now"));
});

test("an update stopped half way finishes next time", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1")] }]));
  const path = pathOf(vault, "aaaaaa-1")!;
  const realReplace = vault.replaceBody.bind(vault);
  vault.replaceBody = async () => { throw new Error("stopped"); };
  await run(vault, feed([{ notes: [thought("aaaaaa-1", { content: "new words", tags: ["t"] })] }]));
  vault.replaceBody = realReplace;
  const { result } = await run(vault, feed([{ notes: [thought("aaaaaa-1", { content: "new words", tags: ["t"] })] }]));
  assert.equal(result.updated, 1);
  assert.ok(vault.files.get(path)!.includes("new words"));
});

test("properties a person broke cost that note, not the sync", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1"), thought("bbbbbb-1")] }]));
  vault.brokenProperties.add(pathOf(vault, "aaaaaa-1")!);
  const { result, memory } = await run(vault, feed([{ notes: [
    thought("aaaaaa-1", { content: "changed" }),
    thought("bbbbbb-1", { content: "changed too" }),
  ] }]));
  assert.equal(result.failedNotes, 1);
  assert.equal(result.updated, 1);
  assert.equal(memory.cursor, "1");
});

test("a retired voice clip stays embedded", async () => {
  const vault = new FakeVault();
  const clip = { id: "clip-1", kind: "audio" as const, mime: "audio/mp4", name: null, size: 3, url: "https://s.example/a" };
  const inner = feed([{ notes: [thought("aaaaaa-1", { files: [clip] })] }]);
  const http: Http = async (req) => req.url.startsWith("https://s.example")
    ? { status: 200, json: null, headers: {}, bytes: new ArrayBuffer(3) } : inner(req);
  await run(vault, http);
  // Past 30 days the server has no file to offer, and the words have changed.
  await run(vault, feed([{ notes: [thought("aaaaaa-1", { content: "new words" })] }]));
  const text = vault.files.get(pathOf(vault, "aaaaaa-1")!)!;
  assert.ok(text.includes("new words"));
  assert.ok(text.includes("![[ThoughtFree/attachments/clip-1.m4a]]"));
});

test("a note moved in Obsidian is found by its id", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1")] }]));
  await vault.move(pathOf(vault, "aaaaaa-1")!, "Elsewhere/renamed by me.md");
  await run(vault, feed([{ notes: [thought("aaaaaa-1", { content: "new words" })] }]));
  assert.equal(vault.files.size, 2); // the note and the .base
  assert.ok(vault.files.get("Elsewhere/renamed by me.md")!.includes("new words"));
});

test("a change of category moves the note, unless the person moved it", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1"), thought("bbbbbb-1")] }]));
  await vault.move(pathOf(vault, "bbbbbb-1")!, "Mine/b.md");
  const { result } = await run(vault, feed([{ notes: [
    thought("aaaaaa-1", { category: "health" }),
    thought("bbbbbb-1", { category: "health" }),
  ] }]));
  assert.equal(result.moved, 1);
  assert.equal(pathOf(vault, "aaaaaa-1"), "ThoughtFree/Health/words of aaaaaa-1 aaaaaa.md");
  assert.equal(pathOf(vault, "bbbbbb-1"), "Mine/b.md");
});

test("Trash marks the note and deletes nothing", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1"), thought("bbbbbb-1")] }]));
  const size = vault.files.size;
  await run(vault, feed([{ notes: [{ id: "aaaaaa-1", state: "trashed" }, { id: "bbbbbb-1", state: "gone" }] }]));
  assert.equal(vault.files.size, size);
  const text = vault.files.get(pathOf(vault, "aaaaaa-1")!)!;
  assert.ok(text.includes('thoughtfree_state: "trashed"'));
  assert.ok(text.includes("words of aaaaaa-1"));
});

test("a thought trashed before it ever arrived writes nothing", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [{ id: "aaaaaa-1", state: "trashed" }] }]));
  assert.equal(vault.indexNotes().size, 0);
});

test("a file already here is taken, not replaced, when the cache lags", async () => {
  const vault = new FakeVault();
  const pages = [{ notes: [thought("aaaaaa-1")] }];
  await run(vault, feed(pages));
  vault.uncached.add(pathOf(vault, "aaaaaa-1")!);
  const { result } = await run(vault, feed(pages));
  assert.equal(result.created, 0);
});

test("two devices on one synced vault write the same file", async () => {
  const pages = [{ notes: [thought("aaaaaa-1"), thought("bbbbbb-1", { category: null })] }];
  const one = new FakeVault();
  const two = new FakeVault();
  await run(one, feed(pages));
  await run(two, feed(pages));
  assert.deepEqual([...one.files.entries()].sort(), [...two.files.entries()].sort());
});

test("a note someone else made at that path is left alone", async () => {
  const vault = new FakeVault();
  const note = thought("aaaaaa-1");
  vault.files.set(notePath(note, CATEGORIES, config()), "my own note");
  const { result } = await run(vault, feed([{ notes: [note] }]));
  assert.equal(result.kept, 1);
  assert.equal(vault.files.get(notePath(note, CATEGORIES, config())), "my own note");
});

test("the cursor moves only after a whole page", async () => {
  const vault = new FakeVault();
  const remembered: string[] = [];
  const sync = new Sync(vault, feed([{ notes: [thought("aaaaaa-1")] }, { notes: [thought("bbbbbb-1")] }]),
    token, "https://feed.example/changes", "1.0.0");
  vault.create = async (path) => {
    if (path.includes("bbbbbb")) throw new Error("disk full");
    vault.files.set(path, 'x');
  };
  await assert.rejects(sync.run(config(), fresh(), async (m) => {
    remembered.push(m.cursor);
  }));
  assert.deepEqual(remembered, ["1"]);
});

test("a stopped sync carries on from where it was", async () => {
  const vault = new FakeVault();
  const pages = [{ notes: [thought("aaaaaa-1")] }, { notes: [thought("bbbbbb-1")] }];
  const seen: string[] = [];
  const { memory } = await run(vault, feed(pages, seen), { cursor: "1", account: null, categories: [] });
  assert.deepEqual(seen, ["1"]);
  assert.equal(memory.cursor, "2");
  assert.equal(vault.indexNotes().has("aaaaaa-1"), false);
});

test("every page of a long feed is read", async () => {
  const vault = new FakeVault();
  const pages = Array.from({ length: 5 }, (_, i) => ({ notes: [thought(`${i}aaaaa-1`)] }));
  const { result } = await run(vault, feed(pages));
  assert.equal(result.created, 5);
});

test("another account stops the sync before anything is written", async () => {
  const vault = new FakeVault();
  await assert.rejects(
    run(vault, feed([{ notes: [thought("aaaaaa-1")] }]), { cursor: "0", account: "someone-else", categories: [] }),
    (e: unknown) => e instanceof FeedStop && e.reason === "sign-in",
  );
  assert.equal(vault.indexNotes().size, 0);
});

test("an expired token is renewed once", async () => {
  const vault = new FakeVault();
  const used: string[] = [];
  const inner = feed([{ notes: [thought("aaaaaa-1")] }]);
  const http: Http = async (req) => {
    const bearer = req.headers?.Authorization ?? "";
    used.push(bearer);
    return bearer === "Bearer t" ? jsonResponse(401, {}) : inner(req);
  };
  const { result } = await run(vault, http);
  assert.equal(result.created, 1);
  assert.deepEqual(used.slice(0, 2), ["Bearer t", "Bearer t2"]);
});

test("a token refused twice asks to sign in", async () => {
  await assert.rejects(run(new FakeVault(), async () => jsonResponse(401, {})),
    (e: unknown) => e instanceof FeedStop && e.reason === "sign-in");
});

for (const [status, reason] of [[402, "pro"], [426, "update"], [429, "later"], [503, "later"]] as const) {
  test(`a ${status} stops cleanly and writes nothing`, async () => {
    const vault = new FakeVault();
    await assert.rejects(run(vault, async () => jsonResponse(status, {})),
      (e: unknown) => e instanceof FeedStop && e.reason === reason);
    assert.equal(vault.indexNotes().size, 0);
  });
}

test("a page shape this build cannot read stops before writing", async () => {
  const vault = new FakeVault();
  await assert.rejects(run(vault, async () => jsonResponse(200, { version: 2, notes: [] })),
    (e: unknown) => e instanceof FeedStop && e.reason === "update");
});

test("a file is fetched once, embedded, and named by us", async () => {
  const vault = new FakeVault();
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  let fetched = 0;
  const inner = feed([{ notes: [thought("aaaaaa-1", {
    files: [{ id: "file-1", kind: "image", mime: "image/png", name: "../../evil.exe", size: 3, url: "https://s.example/f" }],
  })] }]);
  const http: Http = async (req) => {
    if (req.url.startsWith("https://s.example")) {
      fetched++;
      return { status: 200, json: null, headers: {}, bytes };
    }
    return inner(req);
  };
  await run(vault, http);
  await run(vault, http);
  assert.equal(fetched, 1);
  assert.ok(vault.binaries.has("ThoughtFree/attachments/file-1.png"));
  assert.ok(vault.files.get(pathOf(vault, "aaaaaa-1")!)!.includes("![[ThoughtFree/attachments/file-1.png]]"));
});

test("a file of the wrong type or too large is refused, and the note still lands", async () => {
  const vault = new FakeVault();
  const http = feed([{ notes: [thought("aaaaaa-1", { files: [
    { id: "f1", kind: "image", mime: "text/html", name: null, size: 3, url: "https://s.example/a" },
    { id: "f2", kind: "pdf", mime: "application/pdf", name: null, size: 500_000_000, url: "https://s.example/b" },
  ] })] }]);
  const { result } = await run(vault, http);
  assert.equal(result.failedFiles, 2);
  assert.equal(result.created, 1);
  assert.equal(vault.binaries.size, 0);
});

test("a failed file costs that file, not the sync", async () => {
  const vault = new FakeVault();
  const inner = feed([{ notes: [thought("aaaaaa-1", {
    files: [{ id: "f1", kind: "image", mime: "image/png", name: null, size: 3, url: "https://s.example/a" }],
  })] }]);
  const http: Http = async (req) => {
    if (req.url.startsWith("https://s.example")) throw new Error("offline");
    return inner(req);
  };
  const { result } = await run(vault, http);
  assert.equal(result.created, 1);
  assert.equal(result.failedFiles, 1);
});

test("files can be left out", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [thought("aaaaaa-1", {
    files: [{ id: "f1", kind: "image", mime: "image/png", name: null, size: 3, url: "https://s.example/a" }],
  })] }]), fresh(), config({ attachments: false }));
  assert.equal(vault.binaries.size, 0);
});

test("the view ships once, then it is the person's", async () => {
  const vault = new FakeVault();
  await run(vault, feed([{ notes: [] }]));
  assert.equal(vault.files.get("ThoughtFree/ThoughtFree.base"), baseFile("ThoughtFree"));
  vault.files.set("ThoughtFree/ThoughtFree.base", "mine");
  await run(vault, feed([{ notes: [] }]));
  assert.equal(vault.files.get("ThoughtFree/ThoughtFree.base"), "mine");
});
