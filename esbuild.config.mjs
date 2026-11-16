// Builds main.js. `watch` rebuilds on change; both modes copy the plugin into dev-vault/.
import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] ?? 'production';
const prod = mode === 'production';

const DEV_PLUGIN_DIR = path.resolve('dev-vault/.obsidian/plugins/handwritten-annotation');

/** Copy the built plugin into the dev vault so Obsidian can load it. */
const copyToDevVault = {
  name: 'copy-to-dev-vault',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      if (!existsSync(path.resolve('dev-vault'))) return;
      mkdirSync(DEV_PLUGIN_DIR, { recursive: true });
      for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(f, path.join(DEV_PLUGIN_DIR, f));
      console.log(`[build] ${new Date().toLocaleTimeString()} copied to dev-vault`);
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  outfile: 'main.js',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules],
  sourcemap: prod ? false : 'inline',
  minify: prod,
  treeShaking: true,
  logLevel: 'info',
  plugins: [copyToDevVault],
});

if (mode === 'watch') {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
