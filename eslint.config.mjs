// Obsidian's official review rules (the same ones the community plugin review uses).
import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  // build output, Node build scripts, the dev vault and the browser harness are not plugin code
  globalIgnores(['node_modules', 'main.js', 'esbuild.config.mjs', 'scripts', 'harness', 'dev-vault']),
  ...obsidianmd.configs.recommended,
  {
    // Node's test() returns a promise the runner awaits itself; tests read raw JSON on purpose
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.*'],
        },
      },
    },
  },
]);
