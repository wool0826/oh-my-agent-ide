// ESLint for the app and its tests: rules that find bugs, not style (there is no formatter). `npm run lint` runs it.
// The tools live in tools/lint with their own TypeScript 6, because typescript-eslint reads types through the
// TypeScript JS API, which TypeScript 7 (the app's compiler) does not ship. scripts/lint.mjs installs them there.
import { createRequire } from 'node:module';

const need = createRequire(new URL('./tools/lint/package.json', import.meta.url));
const js = need('@eslint/js');
const tseslint = need('typescript-eslint');
const globals = need('globals');

// A fixed wait in an e2e flow passes on a fast machine and fails on a slow one: wait on a condition instead
// (app.until in the page, waitFor in the harness). Only the harness's own helpers sleep.
const fixedSleep = 'A fixed wait: wait on a condition instead (app.until, or waitFor from harness.mjs).';
const noFixedSleep = [
  'error',
  { selector: "NewExpression[callee.name='Promise'] > ArrowFunctionExpression > CallExpression.body[callee.name='setTimeout']", message: fixedSleep },
  { selector: "CallExpression[callee.object.name='Atomics'][callee.property.name='wait']", message: fixedSleep },
  { selector: 'Literal[value=/new Promise\\(\\(?r\\)? => setTimeout\\(r,/]', message: fixedSleep },
  { selector: 'TemplateElement[value.raw=/new Promise\\(\\(?r\\)? => setTimeout\\(r,/]', message: fixedSleep },
];

export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'tools/**', 'build/**', 'resources/**', 'T-*/**', 'test-results/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // node:test hands back a promise from test() that its runner already waits on.
      '@typescript-eslint/no-floating-promises': ['error', { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }] }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      // New code says what it holds; the files that read untyped JSON or SDK fields say so at the top.
      '@typescript-eslint/no-explicit-any': 'error',
      // Matching control characters is the point where it is used (terminal colour codes, placeholder marks).
      'no-control-regex': 'off',
    },
  },
  {
    files: ['test/e2e/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-restricted-syntax': noFixedSleep,
    },
  },
  // Tests reach into stand-ins and stubs that are untyped on purpose.
  { files: ['test/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  { files: ['test/e2e/harness.mjs', 'test/e2e/gh-stub.mjs'], rules: { 'no-restricted-syntax': 'off' } },
);
