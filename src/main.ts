import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  parseYaml,
  requestUrl,
  type EventRef,
  type SettingDefinitionItem,
} from "obsidian";

import { Auth, SignInNeeded, type AuthStore, type Pending, type Tokens } from "./auth.ts";
import { FeedStop } from "./feed.ts";
import { categoryLabel, fingerprint, safeFolder, splitNote, stampFrontmatter } from "./format.ts";
import type { Http } from "./http.ts";
import {
  Sync,
  folderFor,
  type NotePlace,
  type SyncConfig,
  type SyncMemory,
  type VaultPort,
} from "./sync.ts";

declare const __TF_ORIGIN__: string;
declare const __TF_FEED__: string;
declare const __TF_CLIENT__: string;

/** The first sync waits this long after Obsidian settles, so that notes coming
 * in through a vault sync land first and nothing is written twice. */
const SETTLE_MS = 20_000;
const SYNC_EVERY_MS = 30 * 60_000;
/** Past this many changes in one go, a sync asks first. */
const LARGE_CHANGE = 1000;

const TOKENS_SECRET = "thoughtfree-sync-tokens";
const PENDING_KEY = "thoughtfree-sign-in";
const THIS_DEVICE_KEY = "thoughtfree-sync-here";

type Saved = SyncMemory & {
  root: string;
  folders: SyncConfig["folders"];
  attachments: boolean;
  confirmed: boolean;
  lastSync: number | null;
};

const DEFAULTS: Saved = {
  root: "ThoughtFree",
  folders: {},
  attachments: true,
  confirmed: false,
  lastSync: null,
  cursor: "0",
  account: null,
  categories: [],
};

const http: Http = async (request) => {
  const res = await requestUrl({ ...request, throw: false });
  let json: unknown = null;
  try {
    json = res.json;
  } catch {
    // Not JSON: a file, or an error page.
  }
  return { status: res.status, json, headers: res.headers, bytes: res.arrayBuffer };
};

class ObsidianVault implements VaultPort {
  constructor(private readonly app: App) {}

  indexNotes(): Map<string, NotePlace> {
    const index = new Map<string, NotePlace>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const props = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const id: unknown = props?.thoughtfree_id;
      if (typeof id === "string") {
        index.set(id, {
          path: file.path,
          hash: typeof props?.thoughtfree_hash === "string" ? props.thoughtfree_hash : undefined,
          props: typeof props?.thoughtfree_props === "string" ? props.thoughtfree_props : undefined,
          category: typeof props?.thoughtfree_category === "string" ? props.thoughtfree_category : undefined,
        });
      }
    }
    return index;
  }

  private file(path: string): TFile {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) throw new Error(`Missing note: ${path}`);
    return file;
  }

  exists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  read(path: string): Promise<string> {
    return this.app.vault.read(this.file(path));
  }

  async create(path: string, text: string): Promise<void> {
    await this.app.vault.create(normalizePath(path), text);
  }

  parseProperties(frontmatter: string): Record<string, unknown> {
    const yaml = frontmatter.replace(/^---\n/, "").replace(/\n---\n?$/, "");
    return (parseYaml(yaml) ?? {}) as Record<string, unknown>;
  }

  async replaceBody(
    path: string,
    expected: string,
    body: string,
    stamps: { hash: string; props: string },
  ): Promise<boolean> {
    let written = false;
    await this.app.vault.process(this.file(path), (text) => {
      const now = splitNote(text);
      // Inside the write: a person can type between the read and here.
      if (fingerprint(now.body) !== fingerprint(expected)) return text;
      written = true;
      return `${stampFrontmatter(now.frontmatter, stamps.hash, stamps.props)}${body}\n`;
    });
    return written;
  }

  async setProperties(path: string, props: Record<string, unknown>, remove: string[] = []): Promise<void> {
    const file = this.file(path);
    const now = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
    const same =
      Object.entries(props).every(([key, value]) => JSON.stringify(now[key]) === JSON.stringify(value)) &&
      remove.every((key) => !(key in now));
    if (same) return;
    await this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
      Object.assign(front, props);
      for (const key of remove) delete front[key];
    });
  }

  async move(path: string, to: string): Promise<void> {
    await this.app.fileManager.renameFile(this.file(path), normalizePath(to));
  }

  async createBinary(path: string, bytes: ArrayBuffer): Promise<void> {
    await this.app.vault.createBinary(normalizePath(path), bytes);
  }

  async ensureFolder(path: string): Promise<void> {
    let at = "";
    for (const part of normalizePath(path).split("/")) {
      at = at ? `${at}/${part}` : part;
      const found = this.app.vault.getAbstractFileByPath(at);
      if (found instanceof TFolder) continue;
      if (found) throw new Error(`${at} is a file, not a folder.`);
      await this.app.vault.createFolder(at);
    }
  }
}

class Ask extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly detail: string,
    private readonly yes: string,
    private readonly answer: (yes: boolean) => void,
  ) {
    super(app);
  }

  private answered = false;

  override onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { text: this.detail });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Not now").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText(this.yes).setCta().onClick(() => {
          this.answered = true;
          this.answer(true);
          this.close();
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.answer(false);
  }
}

export default class ThoughtFreePlugin extends Plugin {
  saved: Saved = { ...DEFAULTS };
  auth!: Auth;
  status = "";
  private sync!: Sync;
  running = false;
  private unloaded = false;
  private statusBar: HTMLElement | null = null;
  private tab: ThoughtFreeTab | null = null;

  get syncHere(): boolean {
    return this.app.loadLocalStorage(THIS_DEVICE_KEY) !== "off";
  }

  set syncHere(on: boolean) {
    this.app.saveLocalStorage(THIS_DEVICE_KEY, on ? null : "off");
  }

  private authStore(): AuthStore {
    const { app } = this;
    return {
      loadTokens(): Tokens | null {
        const raw = app.secretStorage.getSecret(TOKENS_SECRET);
        return raw ? (JSON.parse(raw) as Tokens) : null;
      },
      saveTokens(tokens) {
        app.secretStorage.setSecret(TOKENS_SECRET, tokens ? JSON.stringify(tokens) : "");
      },
      loadPending(): Pending | null {
        const raw = app.loadLocalStorage(PENDING_KEY);
        return raw ? (JSON.parse(raw) as Pending) : null;
      },
      savePending(pending) {
        app.saveLocalStorage(PENDING_KEY, pending ? JSON.stringify(pending) : null);
      },
    };
  }

  override async onload(): Promise<void> {
    this.saved = { ...DEFAULTS, ...((await this.loadData()) as Partial<Saved> | null) };
    this.auth = new Auth(
      {
        origin: __TF_ORIGIN__,
        clientId: __TF_CLIENT__,
        resource: "https://mcp.thoughtfree.io/vault",
      },
      this.authStore(),
      http,
    );
    this.sync = new Sync(
      new ObsidianVault(this.app),
      http,
      { get: () => this.auth.accessToken(), renew: () => this.auth.refresh() },
      __TF_FEED__,
      this.manifest.version,
    );

    this.statusBar = this.addStatusBarItem();
    this.tab = new ThoughtFreeTab(this.app, this);
    this.addSettingTab(this.tab);

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.runSync(true),
    });

    this.registerObsidianProtocolHandler("thoughtfree-auth", (params) => {
      void this.finishSignIn(params.code ?? "", params.state ?? "");
    });

    this.app.workspace.onLayoutReady(() => {
      // Only once the note index is whole: a sync that cannot see its notes
      // would make them again.
      const start = () => {
        window.setTimeout(() => void this.runSync(false), SETTLE_MS);
      };
      const cache = this.app.metadataCache as unknown as { initialized?: boolean };
      if (cache.initialized) {
        start();
      } else {
        const ref: EventRef = this.app.metadataCache.on("resolved", () => {
          this.app.metadataCache.offref(ref);
          start();
        });
        this.registerEvent(ref);
      }
      this.registerInterval(window.setInterval(() => void this.runSync(false), SYNC_EVERY_MS));
    });
  }

  override onunload(): void {
    this.unloaded = true;
  }

  async save(): Promise<void> {
    await this.saveData(this.saved);
  }

  async startSignIn(): Promise<void> {
    window.open(await this.auth.begin());
    this.tab?.display();
  }

  async finishSignIn(code: string, state?: string): Promise<void> {
    if (!code.trim()) return;
    try {
      await this.auth.finish(code, state);
      new Notice("ThoughtFree connected");
      this.tab?.display();
      await this.runSync(true);
    } catch (err) {
      new Notice(err instanceof Error ? err.message : "Could not connect to ThoughtFree");
    }
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.saved.confirmed = false;
    await this.save();
    this.show("");
    this.tab?.display();
  }

  /** From the start again. Safe: every write is the same write, and a note a
   * person changed is still left alone. */
  async resync(): Promise<void> {
    this.saved.cursor = "0";
    await this.save();
    await this.runSync(true);
  }

  private show(text: string): void {
    this.status = text;
    this.statusBar?.setText(text);
  }

  private config(): SyncConfig {
    return {
      root: safeFolder(this.saved.root, "ThoughtFree"),
      folders: this.saved.folders,
      attachments: this.saved.attachments,
    };
  }

  private ask(heading: string, detail: string, yes: string): Promise<boolean> {
    return new Promise((resolve) => new Ask(this.app, heading, detail, yes, resolve).open());
  }

  /** [manual] is a person pressing something, so it may ask and report. */
  async runSync(manual: boolean): Promise<void> {
    if (this.running || !this.auth.signedIn) return;
    if (!manual && !this.syncHere) return;
    this.running = true;
    try {
      const preview = await this.sync.preview(this.saved);
      const count = preview.notes.length + preview.remaining;
      const first = !this.saved.confirmed;
      if (first || count > LARGE_CHANGE) {
        if (!manual) {
          this.show(`ThoughtFree: ${count} changes waiting. Sync now to bring them in.`);
          return;
        }
        const go = await this.ask(
          first ? "Bring your thoughts in?" : `${count} changes to sync`,
          `${count} thoughts go into ${this.config().root}, one note each. Nothing else in your vault changes.`,
          "Sync",
        );
        if (!go) return;
        this.saved.confirmed = true;
        await this.save();
      }
      this.show("ThoughtFree: syncing");
      const result = await this.sync.run(
        this.config(),
        this.saved,
        async (memory) => {
          Object.assign(this.saved, memory);
          await this.save();
        },
        () => this.unloaded,
      );
      this.saved.lastSync = Date.now();
      await this.save();
      this.show("");
      this.tab?.display();
      if (manual) {
        const parts = [`${result.created} new`, `${result.updated} updated`];
        if (result.kept) parts.push(`${result.kept} kept as you left them`);
        if (result.failedFiles) parts.push(`${result.failedFiles} files could not be fetched`);
        if (result.failedNotes) parts.push(`${result.failedNotes} notes could not be read`);
        new Notice(`ThoughtFree: ${parts.join(", ")}`);
      }
    } catch (err) {
      const message =
        err instanceof SignInNeeded
          ? "Sign in to ThoughtFree again."
          : err instanceof FeedStop
            ? err.message
            : "ThoughtFree could not sync. It will try again later.";
      this.show(`ThoughtFree: ${message}`);
      if (manual) new Notice(message);
      this.tab?.display();
    } finally {
      this.running = false;
    }
  }
}

class ThoughtFreeTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ThoughtFreePlugin,
  ) {
    super(app, plugin);
  }

  private pasted = "";

  /** Every row, once: `display` draws them below Obsidian 1.13, and
   * `getSettingDefinitions` hands the same ones to its settings search. */
  private rows(): Row[] {
    const { plugin } = this;
    const saved = plugin.saved;
    const rows: Row[] = [];

    if (plugin.auth.signedIn) {
      rows.push({
        name: "Account",
        desc: plugin.status || lastSyncLine(saved.lastSync),
        render: (s) => s
          .addButton((b) => b.setButtonText("Sync now").setCta().onClick(() => void plugin.runSync(true)))
          .addButton((b) => b.setButtonText("Disconnect").onClick(() => void plugin.signOut())),
      });
    } else {
      rows.push({
        name: "Account",
        desc: "Connect to bring your thoughts into this vault.",
        render: (s) => s
          .addButton((b) => b.setButtonText("Connect").setCta().onClick(() => void plugin.startSignIn())),
      });
      rows.push({
        name: "Sign-in code",
        desc: "If Obsidian did not open after you allowed it, paste the code here.",
        render: (s) => s
          .addText((t) => t.onChange((v) => (this.pasted = v)))
          .addButton((b) => b.setButtonText("Use code").onClick(() => void plugin.finishSignIn(this.pasted))),
      });
    }

    rows.push({
      name: "Folder",
      desc: "Thoughts go here, in a folder per category.",
      render: (s) => s.addText((t) =>
        t.setValue(saved.root).onChange(async (v) => {
          // A new folder is a new tree: it starts from the beginning, and it
          // is how a vault takes on another account.
          saved.root = v;
          saved.cursor = "0";
          saved.account = null;
          saved.confirmed = false;
          await plugin.save();
        }),
      ),
    });

    rows.push({
      name: "Sync on this device",
      desc: "Turn off on all but one device if a sync service also copies this vault.",
      render: (s) => s.addToggle((t) => t.setValue(plugin.syncHere).onChange((v) => (plugin.syncHere = v))),
    });

    rows.push({
      name: "Photos, PDFs and voice clips",
      desc: "Keep a copy in the vault.",
      render: (s) => s.addToggle((t) =>
        t.setValue(saved.attachments).onChange(async (v) => {
          saved.attachments = v;
          await plugin.save();
        }),
      ),
    });

    if (saved.categories.length) {
      rows.push({ name: "Categories", render: (s) => s.setHeading() });
      const config: SyncConfig = { root: safeFolder(saved.root, "ThoughtFree"), folders: {}, attachments: false };
      for (const category of [...saved.categories].sort((a, b) => a.label.localeCompare(b.label))) {
        const choice = saved.folders[category.key] ?? {};
        rows.push({
          name: categoryLabel(category.key, saved.categories),
          render: (s) => s
            .addText((t) =>
              t
                .setPlaceholder(folderFor(category.key, saved.categories, config))
                .setValue(choice.folder ?? "")
                .onChange(async (v) => {
                  saved.folders[category.key] = { ...saved.folders[category.key], folder: v };
                  await plugin.save();
                }),
            )
            .addToggle((t) =>
              t
                .setTooltip("Sync this category")
                .setValue(!choice.skip)
                .onChange(async (v) => {
                  saved.folders[category.key] = { ...saved.folders[category.key], skip: !v };
                  // What was skipped went past the cursor, so back to the start.
                  if (v) saved.cursor = "0";
                  await plugin.save();
                }),
            ),
        });
      }
    }

    if (plugin.auth.signedIn) {
      rows.push({
        name: "Resync everything",
        desc: "Reads every thought again. Notes you changed stay as they are.",
        render: (s) => s.addButton((b) => b.setButtonText("Resync").onClick(() => void plugin.resync())),
      });
    }
    return rows;
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return this.rows().map((row) => ({
      name: row.name,
      ...(row.desc ? { desc: row.desc } : {}),
      render: (setting: Setting) => drawRow(setting, row),
    }));
  }

  display(): void {
    this.containerEl.empty();
    for (const row of this.rows()) drawRow(new Setting(this.containerEl), row);
  }
}

type Row = { name: string; desc?: string; render: (setting: Setting) => unknown };

function drawRow(setting: Setting, row: Row): void {
  setting.setName(row.name);
  if (row.desc) setting.setDesc(row.desc);
  row.render(setting);
}

function lastSyncLine(at: number | null): string {
  return at ? `Last synced ${new Date(at).toLocaleString()}` : "Not synced yet.";
}
