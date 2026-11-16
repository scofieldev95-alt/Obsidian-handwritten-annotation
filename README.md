# Handwritten Annotation

Write by hand on the PDFs and images embedded in your Obsidian notes — right where they are, between
your typed text. Your ink stays with the file, syncs with your vault, and the original PDF or image
is never changed.

## Features

- **Write inside your notes.** `![[lecture.pdf]]` and `![[diagram.png]]` become pages you can write
  on, in editing and reading view. Your finger or trackpad still scrolls the note.
- **One PDF page at a time**, with arrows and "go to page". `![[lecture.pdf#page=4]]` always starts
  on page 4; otherwise a PDF opens on the last page you viewed, on any device.
- **Full screen** with zoom (pinch, ⌘/Ctrl + scroll, or the zoom buttons). PDFs opened from the
  file list show your ink too.
- **Tools:** pen (pressure-sensitive with Apple Pencil and pen tablets), highlighter, eraser (whole
  stroke or partial), lasso to select and move ink, five colours per tool plus a custom colour,
  three thicknesses, and undo/redo for each page.
- **Images:** PNG, JPG and WebP. `![[image.png|300]]` keeps its width.
- **Hotkeys:** every tool is a command, so you can assign hotkeys in Settings → Hotkeys.

## How your ink is stored

- Your PDFs and images are **never modified**. Nothing is added to your notes either.
- Ink is saved in a hidden folder inside your vault, `.obsidian/handwritten-annotation/`, so it
  syncs with the vault (iCloud, Obsidian Sync, Syncthing, Git…).
- Each device writes only its own files, so two devices never edit the same file and sync tools
  have nothing to conflict on. Ink from all your devices is merged when you open a file.
- Rename or move a PDF or image — even a whole folder — and its ink follows. A file renamed outside
  Obsidian is recognised by its content. Ink of a deleted file is kept for 10 days in case the file
  comes back.

## Privacy

The plugin makes **no network requests**: no telemetry, no accounts, no downloads. PDFs are drawn
with the PDF engine that ships with Obsidian.

## Installation

From Obsidian: **Settings → Community plugins → Browse**, search for **Handwritten Annotation**,
then **Install** and **Enable**.

Manually: download `main.js`, `manifest.json` and `styles.css` from the
[latest release](../../releases/latest) into `<vault>/.obsidian/plugins/handwritten-annotation/`,
then enable the plugin in Settings → Community plugins.

## Settings

- **Draw with a finger** (iPad / iPhone): off by default, so a finger scrolls and only the pencil writes.
- **PDFs in notes**, **Images in notes**, **Open PDFs with handwritten annotation**: turn each part
  off to get Obsidian's normal behaviour back for it.

## Known limitations

- Ink shows inside Obsidian only; other apps see the original, unmodified PDF or image.
- SVG, GIF and other image types keep Obsidian's normal embed.
- iPad and iPhone support (Apple Pencil pressure, palm rejection, pinch to zoom) is implemented but
  has had little testing on real devices yet. Feedback is welcome.
- To take over PDF and image embeds, the plugin uses two Obsidian APIs that are not part of the
  official plugin API (the view and embed registries). They are isolated in
  [`src/obsidian-internals.ts`](src/obsidian-internals.ts), and if a future Obsidian version
  changes them, the plugin falls back to Obsidian's normal viewers instead of breaking.

## Development

```bash
npm install
npm run dev        # rebuild on change, copies the plugin into dev-vault/ if it exists
npm run verify     # type-check, Obsidian's lint rules, unit tests, production build
```

Create a `dev-vault/` folder, open it in Obsidian (**Open folder as vault**), enable community
plugins, and run `npm run dev`. After a rebuild, run **Reload app without saving**.
`scripts/make-sample-pdf.mjs` and `scripts/make-sample-image.py` create test files.

`harness/` runs the editor in a plain browser page with a small stand-in for the Obsidian API.

### Releasing

```bash
npm version patch   # or minor / major: updates package.json, manifest.json, versions.json and tags
git push --follow-tags
```

The tag starts the release workflow, which verifies, builds and creates a **draft** GitHub release
with `main.js`, `manifest.json` and `styles.css`. Review it and publish.

### Code layout

| Path | What |
|---|---|
| `src/ink/` | Ink engine: smoothing, stroke geometry, eraser and lasso hit tests (no DOM, unit-tested) |
| `src/model/` | `InkDocument`: the ink of one file, merged from every device |
| `src/store/` | Hidden per-device ink files, merged on read |
| `src/pdf/`, `src/image/` | Pages of PDFs (Obsidian's PDF.js) and images |
| `src/surface/` | The writable page (canvas layers, pointer input), toolbar, annotator |
| `src/embed/`, `src/views/` | Embeds in notes and the full-screen view |
| `src/obsidian-internals.ts` | The only place that uses unofficial Obsidian APIs |
| `tests/` | Unit tests (Node's built-in runner) |

## License

[MIT](LICENSE)
