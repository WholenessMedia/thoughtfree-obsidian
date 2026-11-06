# ThoughtFree for Obsidian

Keep your [ThoughtFree](https://thoughtfree.io) thoughts in your vault, one note each, in the folders you choose.

## What it does

- **One note per thought**, with properties for its category, kind, tags and dates, so Bases and search can read them. A ready-made table view comes with it.
- **A folder per category**, chosen by you, or leave a category out.
- **Your edits win.** Change a note and it stays changed, whatever happens to the thought in the app.
- **Nothing is ever deleted from your vault.** A thought moved to Trash in ThoughtFree changes one property on its note.
- **Move and rename freely.** Notes are found by their id, not their place.
- **Photos, PDFs and voice clips** are copied in, if you want them.

It syncs when Obsidian opens and every 30 minutes, one way, from ThoughtFree into your vault. The ThoughtFree app can also send a single thought or today's diary to Obsidian on its own, with no plugin.

## Setting up

1. Open **Settings > ThoughtFree** and choose **Connect**.
2. Sign in and allow it. It can read your thoughts and cannot change anything.
3. Back in Obsidian, confirm the first sync.

If Obsidian does not reopen after you allow it, paste the code from the page into **Sign-in code**.

If a sync service also copies this vault between your devices, turn **Sync on this device** off on all but one of them.

## What you should know

**An account is required.** This plugin needs a ThoughtFree account.

**Network use.** The plugin talks to one service, ThoughtFree, at `mcp.thoughtfree.io`, to sign in and to read what changed. Attachments are fetched from ThoughtFree's storage on signed links that last 15 minutes. It contains no telemetry and no ads.

**What it can reach.** Its access is read-only and covers your thoughts, comments, categories and attachments. It never reads your diary, which ThoughtFree's server does not read either.

**Your vault.** Thoughts become ordinary files. Once there, they are as private as your vault is: anything that syncs or backs up your vault will hold them too.

**Your sign-in.** It is kept in Obsidian's secret storage on each device, never in the plugin's data file, so it does not travel with your vault. Each device signs in on its own. Disconnect from the plugin, or from Connected apps in ThoughtFree.

**Text from the web.** A thought can hold a clipped page, so anything in one that could run in your vault or fetch from the internet, such as a Dataview block or a remote image, is written so that it does neither.

## Development

```bash
npm install
npm run check   # types, tests, build
```

`src/format.ts` is a contract with the ThoughtFree app, which writes the same notes into its vault ZIP. Both render `fixtures/notes.json`. Regenerate it with `node --experimental-transform-types scripts-gen-fixtures.mjs` after a deliberate change, and copy it to the app.

## Reporting a security issue

Write to support@thoughtfree.io. Please do not open a public issue.

## License

MIT
