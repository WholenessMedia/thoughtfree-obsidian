import type { NotePlace, VaultPort } from "../src/sync.ts";
import { fingerprint, splitNote, stampFrontmatter } from "../src/format.ts";
import type { Http, HttpRequest } from "../src/http.ts";

/** A vault in memory that reads its own properties the way the note cache does. */
export class FakeVault implements VaultPort {
  files = new Map<string, string>();
  binaries = new Map<string, ArrayBuffer>();
  folders = new Set<string>();
  /** Notes the cache has not caught up with yet. */
  uncached = new Set<string>();

  indexNotes(): Map<string, NotePlace> {
    const index = new Map<string, NotePlace>();
    for (const [path, text] of this.files) {
      if (this.uncached.has(path)) continue;
      const { frontmatter } = splitNote(text);
      const id = /thoughtfree_id: "?([^"\n]+)/.exec(frontmatter)?.[1];
      if (!id) continue;
      index.set(id, {
        path,
        hash: /thoughtfree_hash: "?([0-9a-f]+)/.exec(frontmatter)?.[1],
        props: /thoughtfree_props: "?([0-9a-f]+)/.exec(frontmatter)?.[1],
        category: /thoughtfree_category: "?([^"\n]*)/.exec(frontmatter)?.[1],
      });
    }
    return index;
  }
  exists(path: string): boolean {
    return this.files.has(path) || this.binaries.has(path) || this.folders.has(path);
  }
  async read(path: string): Promise<string> {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`no file ${path}`);
    return text;
  }
  async create(path: string, text: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`already exists: ${path}`);
    this.files.set(path, text);
  }
  /** Runs after the read in [replaceBody]: a person typing mid-write. */
  beforeWrite: (() => void) | null = null;

  parseProperties(frontmatter: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let list: string | null = null;
    for (const line of frontmatter.split("\n")) {
      if (line === "---" || line === "") continue;
      if (line.startsWith("  - ")) {
        (out[list!] as unknown[]).push(JSON.parse(line.slice(4)));
        continue;
      }
      const at = line.indexOf(":");
      const key = line.slice(0, at);
      const value = line.slice(at + 1).trim();
      if (value === "") {
        list = key;
        out[key] = [];
      } else {
        out[key] = JSON.parse(value);
      }
    }
    return out;
  }
  async replaceBody(path: string, expected: string, body: string, stamps: { hash: string; props: string }): Promise<boolean> {
    this.beforeWrite?.();
    const now = splitNote(await this.read(path));
    if (fingerprint(now.body) !== fingerprint(expected)) return false;
    this.files.set(path, `${stampFrontmatter(now.frontmatter, stamps.hash, stamps.props)}${body}\n`);
    return true;
  }
  async setProperties(path: string, props: Record<string, unknown>, remove: string[] = []): Promise<void> {
    if (this.brokenProperties.has(path)) throw new Error("bad YAML");
    const text = await this.read(path);
    const { frontmatter, body } = splitNote(text);
    const all = { ...this.parseProperties(frontmatter), ...props };
    for (const key of remove) delete all[key];
    const lines: string[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (Array.isArray(value)) {
        lines.push(`${key}:`, ...value.map((v) => `  - ${JSON.stringify(v)}`));
      } else {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    this.files.set(path, `---\n${lines.join("\n")}\n---\n${body}`);
  }
  brokenProperties = new Set<string>();
  async move(path: string, to: string): Promise<void> {
    const text = await this.read(path);
    this.files.delete(path);
    this.files.set(to, text);
  }
  async createBinary(path: string, bytes: ArrayBuffer): Promise<void> {
    this.binaries.set(path, bytes);
  }
  async ensureFolder(path: string): Promise<void> {
    this.folders.add(path);
  }
}

export function jsonResponse(status: number, json: unknown) {
  return { status, json, headers: {}, bytes: new ArrayBuffer(0) };
}

export type Handler = (request: HttpRequest) => ReturnType<Http>;
