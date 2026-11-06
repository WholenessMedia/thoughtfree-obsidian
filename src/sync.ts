// One sync: read what changed, and bring the vault up to it.
//
// The rules, in order of how much they matter:
//   1. A person's note wins. If its words are not the words we last wrote, they
//      stay, whatever the app now says.
//   2. Nothing is ever deleted from a vault, or overwritten that we did not
//      make. Trash in the app changes one property.
//   3. A note is found by its id, never by where it is, so moving or renaming
//      one in Obsidian changes nothing.
//   4. The cursor moves only after a whole page is written, and every write is
//      safe to repeat, so an interrupted sync simply carries on.
//
// Written against VaultPort, not Obsidian, so all of this runs under
// `node --test`. `main.ts` holds the real one.

import { FeedStop, fetchPage, type FeedPage } from "./feed.ts";
import {
  MANAGED_PROPERTIES,
  categoryLabel,
  embedsIn,
  fileNameFor,
  fingerprint,
  noteFileName,
  normalizeBody,
  properties,
  propertiesPrint,
  renderBody,
  renderNote,
  safeFolder,
  safeSegment,
  splitNote,
  type FeedCategory,
  type FeedFile,
  type FeedNote,
} from "./format.ts";
import type { Http } from "./http.ts";

export type NotePlace = { path: string; hash?: string; props?: string; category?: string };

export interface VaultPort {
  /** Every note holding a thought, by id, wherever it now is. */
  indexNotes(): Map<string, NotePlace>;
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  create(path: string, text: string): Promise<void>;
  /** The properties in a note's frontmatter text. */
  parseProperties(frontmatter: string): Record<string, unknown>;
  /** Set [props], and remove [remove]. */
  setProperties(path: string, props: Record<string, unknown>, remove?: string[]): Promise<void>;
  /**
   * In ONE write: if the words are still [expected], replace them and set the
   * two stamps. False when they are not, which is a person typing right now.
   */
  replaceBody(
    path: string,
    expected: string,
    body: string,
    stamps: { hash: string; props: string },
  ): Promise<boolean>;
  move(path: string, to: string): Promise<void>;
  createBinary(path: string, bytes: ArrayBuffer): Promise<void>;
  ensureFolder(path: string): Promise<void>;
}

export type FolderChoice = { folder?: string; skip?: boolean };

export type SyncConfig = {
  root: string;
  folders: Record<string, FolderChoice>;
  attachments: boolean;
};

export type SyncMemory = {
  cursor: string;
  account: string | null;
  categories: FeedCategory[];
};

export type SyncResult = {
  created: number;
  updated: number;
  kept: number;
  moved: number;
  failedFiles: number;
  /** Notes that could not be touched, such as properties a person broke. */
  failedNotes: number;
  remaining: number;
};

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const SAFE_MIME = /^(image\/(webp|png|jpeg|gif|heic)|application\/pdf|audio\/(mp4|m4a|mpeg|wav|webm|ogg))$/;

/** The folder a category's notes live in. */
export function folderFor(
  key: string | null | undefined,
  categories: readonly FeedCategory[],
  config: SyncConfig,
): string {
  const choice = config.folders[key ?? ""]?.folder?.trim();
  if (choice) return safeFolder(choice, config.root);
  return `${config.root}/${safeSegment(categoryLabel(key, categories), "Uncategorized")}`;
}

export function notePath(
  note: FeedNote,
  categories: readonly FeedCategory[],
  config: SyncConfig,
): string {
  return `${folderFor(note.category, categories, config)}/${noteFileName(note)}`;
}

/** The view that ships with a sync. Created once, then it is the person's. */
export function baseFile(root: string): string {
  return [
    "filters:",
    "  and:",
    "    - thoughtfree_id != null",
    `    - file.inFolder(${JSON.stringify(root)})`,
    "views:",
    "  - type: table",
    "    name: Thoughts",
    "    order:",
    "      - file.name",
    "      - category",
    "      - kind",
    "      - created",
    "      - due",
    "      - tags",
    "    sort:",
    "      - property: created",
    "        direction: DESC",
    "",
  ].join("\n");
}

export class Sync {
  constructor(
    private readonly vault: VaultPort,
    private readonly http: Http,
    private readonly token: { get(): Promise<string>; renew(): Promise<string> },
    private readonly feedUrl: string,
    private readonly version: string,
  ) {}

  /** The first page, for the count a first sync asks about. Writes nothing. */
  async preview(memory: SyncMemory): Promise<FeedPage> {
    return this.page(memory.cursor);
  }

  private async page(after: string): Promise<FeedPage> {
    let token = await this.token.get();
    let page = await fetchPage(this.http, this.feedUrl, token, after, this.version);
    if (page === "expired") {
      token = await this.token.renew();
      page = await fetchPage(this.http, this.feedUrl, token, after, this.version);
    }
    if (page === "expired") throw new FeedStop("Sign in to ThoughtFree again.", "sign-in");
    return page;
  }

  /**
   * Runs until the feed is empty or [shouldStop] says so. [remember] is called
   * after every whole page, so the next run starts from there.
   */
  async run(
    config: SyncConfig,
    memory: SyncMemory,
    remember: (memory: SyncMemory) => Promise<void>,
    shouldStop: () => boolean = () => false,
  ): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, kept: 0, moved: 0, failedFiles: 0, failedNotes: 0, remaining: 0 };
    let at = memory;
    await this.vault.ensureFolder(config.root);
    const base = `${config.root}/ThoughtFree.base`;
    if (!this.vault.exists(base)) await this.vault.create(base, baseFile(config.root));

    const index = this.vault.indexNotes();
    for (;;) {
      if (shouldStop()) return result;
      const page = await this.page(at.cursor);
      // ⚠️ One folder, one account. Two people's notes in one tree would read
      // as one library.
      if (at.account && at.account !== page.account) {
        throw new FeedStop("This folder holds another ThoughtFree account. Choose a new folder in settings.", "sign-in");
      }
      for (const note of page.notes) {
        try {
          await this.apply(note, page.categories, config, index, result);
        } catch (err) {
          // ⚠️ One note that is already there, say with properties a person
          // left broken, must not stop every change after it. A note that
          // could not be CREATED does stop the run: that is a full disk, and
          // moving the cursor past it would lose the thought.
          if (!index.has(note.id)) throw err;
          result.failedNotes++;
        }
      }
      at = { cursor: page.next, account: page.account, categories: page.categories };
      await remember(at);
      result.remaining = page.remaining;
      if (!page.more) return result;
    }
  }

  private async apply(
    note: FeedNote,
    categories: readonly FeedCategory[],
    config: SyncConfig,
    index: Map<string, NotePlace>,
    result: SyncResult,
  ): Promise<void> {
    const known = index.get(note.id);

    if (note.state === "trashed" || note.state === "gone") {
      if (known) await this.vault.setProperties(known.path, { thoughtfree_state: note.state });
      return;
    }
    if (config.folders[note.category ?? ""]?.skip) return;

    const target = notePath(note, categories, config);
    let place = known;

    if (!place && this.vault.exists(target)) {
      // The index runs on a cache: the file can be there before it is. Only a
      // note that says it is this thought is taken as ours.
      const { frontmatter } = splitNote(await this.vault.read(target));
      if (!frontmatter.includes(note.id)) {
        result.kept++;
        return;
      }
      const said = this.vault.parseProperties(frontmatter);
      place = {
        path: target,
        hash: typeof said.thoughtfree_hash === "string" ? said.thoughtfree_hash : undefined,
        props: typeof said.thoughtfree_props === "string" ? said.thoughtfree_props : undefined,
        category: typeof said.thoughtfree_category === "string" ? said.thoughtfree_category : undefined,
      };
    }

    if (!place) {
      const embeds = await this.fetchFiles(note, config, result);
      await this.vault.ensureFolder(target.slice(0, target.lastIndexOf("/")));
      await this.vault.create(target, renderNote(note, categories, embeds));
      index.set(note.id, {
        path: target,
        hash: fingerprint(renderBody(note, embeds)),
        props: propertiesPrint(properties(note, categories)),
        category: note.category ?? "",
      });
      result.created++;
      return;
    }

    const { frontmatter, body: onDisk } = splitNote(await this.vault.read(place.path));
    const wanted = properties(note, categories);
    const wantedPrint = propertiesPrint(wanted);
    const print = propertiesPrint(this.vault.parseProperties(frontmatter));
    // Equal to what we are about to write is an update stopped half way, not a
    // person: properties land first, and the stamps with the words after.
    const untouched =
      !!place.hash &&
      !!place.props &&
      fingerprint(onDisk) === place.hash &&
      (print === place.props || print === wantedPrint);

    if (!untouched) {
      // The person's note stands, in full.
      result.kept++;
      await this.vault.setProperties(place.path, { thoughtfree_state: note.state });
      return;
    }

    // ⚠️ What is embedded stays embedded. A voice clip is retired on the server
    // at 30 days, and the copy here may then be the last one anywhere: a note
    // rewritten without it would leave that file with nothing pointing at it.
    const fetched = await this.fetchFiles(note, config, result);
    const embeds = [...new Set([...fetched, ...embedsIn(onDisk, `${config.root}/attachments`)])];
    const body = normalizeBody(renderBody(note, embeds));
    const hash = fingerprint(body);

    if (hash === place.hash && wantedPrint === place.props) {
      await this.vault.setProperties(place.path, { thoughtfree_state: note.state });
    } else {
      const absent = MANAGED_PROPERTIES.filter((key) => !(key in wanted));
      await this.vault.setProperties(place.path, wanted, absent);
      const written = await this.vault.replaceBody(place.path, onDisk, body, { hash, props: wantedPrint });
      if (!written) {
        result.kept++;
        return;
      }
      if (hash !== place.hash) result.updated++;
    }
    index.set(note.id, { path: place.path, hash, props: wantedPrint, category: note.category ?? "" });

    // Follow a change of category, only out of the folder we put it in.
    const before = folderFor(place.category, categories, config);
    const after = folderFor(note.category, categories, config);
    const folder = place.path.slice(0, place.path.lastIndexOf("/"));
    if (before !== after && folder === before) {
      const to = `${after}/${place.path.slice(place.path.lastIndexOf("/") + 1)}`;
      if (!this.vault.exists(to)) {
        await this.vault.ensureFolder(after);
        await this.vault.move(place.path, to);
        index.set(note.id, { path: to, hash, props: wantedPrint, category: note.category ?? "" });
        result.moved++;
      }
    }
  }

  /** The vault paths of [note]'s files, fetching those not here yet. A failed
   * file costs that file: it is counted, and Resync everything tries again. */
  private async fetchFiles(
    note: FeedNote,
    config: SyncConfig,
    result: SyncResult,
  ): Promise<string[]> {
    if (!config.attachments) return [];
    const paths: string[] = [];
    const folder = `${config.root}/attachments`;
    for (const file of note.files ?? []) {
      const path = `${folder}/${fileNameFor(file)}`;
      if (this.vault.exists(path)) {
        paths.push(path);
      } else if (await this.fetchOne(file, path, folder)) {
        paths.push(path);
      } else {
        result.failedFiles++;
      }
    }
    return paths;
  }

  private async fetchOne(file: FeedFile, path: string, folder: string): Promise<boolean> {
    if (!file.mime || !SAFE_MIME.test(file.mime)) return false;
    if (file.size && file.size > MAX_FILE_BYTES) return false;
    try {
      const res = await this.http({ url: file.url });
      if (res.status !== 200 || res.bytes.byteLength > MAX_FILE_BYTES) return false;
      await this.vault.ensureFolder(folder);
      await this.vault.createBinary(path, res.bytes);
      return true;
    } catch {
      return false;
    }
  }
}
