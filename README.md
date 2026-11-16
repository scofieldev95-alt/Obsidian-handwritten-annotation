# Handwritten Annotation

An Obsidian plugin for writing by hand on PDFs and images embedded in your notes. The ink stays
with the file, syncs between devices through your vault (iCloud), and the original PDF or image is
never changed. *(Working name. In development.)*

## Development

```bash
npm install
npm run dev        # rebuild on change, copies the plugin into dev-vault/
npm test           # unit tests (Node's built-in runner)
npm run verify     # type-check + tests + production build
```

Open `dev-vault/` in Obsidian (**Open folder as vault**) and enable community plugins. After a
rebuild, run **Reload app without saving** from the command palette.

`harness/` runs the editor in a plain browser page (with a small stand-in for the Obsidian API):
`npx esbuild harness/main.ts --bundle --alias:obsidian=./harness/obsidian-stub.ts --outfile=harness/harness.js`,
then serve the project folder and open `harness/index.html`.

## Layout

| Path | What |
|---|---|
| `src/ink/` | Ink engine: smoothing, stroke geometry, eraser and lasso hit tests (no DOM, unit-tested) |
| `src/model/` | `InkDocument`: the ink of one file, merged from every device |
| `src/surface/` | The writable page (canvas layers, pointer input), toolbar, annotator |
| `src/views/` | Obsidian views |
| `tests/` | Unit tests |
