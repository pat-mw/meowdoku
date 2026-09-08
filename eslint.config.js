import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'handover',
      'coverage',
      'src/routeTree.gen.ts',
      'dev-dist',
      'playwright-report',
      'test-results',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat['recommended-latest'],
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // The pure game core is shared by the app, the generator worker and the tests.
    // It must never reach for React or any DOM/browser global. The worker entry
    // is the single boundary file and is exempted below.
    files: ['src/board/**/*.ts'],
    ignores: ['src/board/*.worker.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage', 'self'],
      'no-restricted-imports': [
        'error',
        { patterns: ['react', 'react-dom', 'react*', '@tanstack/*', 'zustand*'] },
      ],
    },
  },
  {
    files: ['**/*.js', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'scripts/**'],
    languageOptions: { globals: { ...globals.node } },
  },
)
