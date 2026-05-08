// ESLint 9 flat config for the Bongos-Hero monorepo.
// Strict: typescript-eslint recommended-type-checked + stylistic-type-checked,
// with eslint-config-prettier disabling stylistic rules that conflict with Prettier.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/build/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'data/**',
      'docs/**',
      'eslint.config.js',
      '**/vite.config.ts',
      '**/vitest.config.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Server: Node environment
  {
    files: ['apps/server/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Web: Browser environment
  {
    files: ['apps/web/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Shared: pure ES modules, no DOM/Node globals
  {
    files: ['packages/shared/**/*.ts'],
    languageOptions: {
      globals: {},
    },
  },

  // Project-wide rule tweaks. Keep these minimal — favor the recommended sets.
  {
    rules: {
      // tsconfig.base has verbatimModuleSyntax: false, so do not force
      // `import type` everywhere — it would create churn without benefit.
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],

      // Allow `_`-prefixed unused args/vars (common pattern).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Smoke / demo / script files: looser rules — they're dev-time entry points.
  {
    files: [
      '**/__smoke__/**',
      '**/__tests__/**',
      '**/__*Demo__*.ts',
      '**/scripts/**',
      '**/*.smoke.ts',
    ],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      'no-console': 'off',
    },
  },

  // Disable stylistic rules that conflict with Prettier. Must be last.
  prettierConfig,
);
