// ESLint flat config（ESLint 9 + typescript-eslint）
//
// 关键约束（总纲原则 6）：业务代码不认识 AWS——@aws-sdk/* 只允许出现在 backend/src/adapters/、backend/src/modules/detectors/、
// scripts/、lambdas/（以及测试中的 aws-sdk-client-mock）。前端的 AWS 代码只能经动态 import() 按需加载（总纲 12.1）。
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ATL platform (platform/**): AWS-native, but pure layers stay SDK-free, and production code never imports the dev
// runtime (platform/api/src/dev/**) or the in-process simulator (@atl/workflows) — docs/implementation-notes.md platform-scaffold.
const atlSdkPattern = {
  group: ['@aws-sdk/*'],
  message: 'ATL: @aws-sdk/* is not allowed in platform/shared, platform/workflows/src, platform/web or platform/api/src/domain (pure layers).',
};
const atlDevPattern = {
  group: ['**/dev/*', '**/dev/**', '@atl/workflows', '@atl/workflows/*'],
  message: 'ATL: production code must not import the dev runtime (src/dev/**) or the simulator (@atl/workflows).',
};

const awsSdkRestriction = {
  patterns: [
    {
      group: ['@aws-sdk/*'],
      message: '@aws-sdk/* 只允许出现在 adapters/、modules/detectors/、scripts/、lambdas/（总纲原则 6）；L0 运行时不得加载 AWS SDK。',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'coverage/**',
      '.cloudalbum/**',
      'experiments/_results/**',
      'experiments/_reports/**',
      '.atl-dev/**',
      'platform/api/dist-lambda/**',
      'platform/infra/dist/**',
      'packages/contracts/src/generated/**',
      'docs/**',
      // git worktrees of other agent sessions (.git/info/exclude) — not part of this checkout
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true,
      }],
      'no-restricted-imports': ['error', awsSdkRestriction],
    },
  },
  {
    files: [
      'backend/src/adapters/**',
      'backend/src/modules/detectors/**',
      'scripts/**',
      'lambdas/**',
      '**/test/**',
      '**/*.test.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  // ---- ATL platform ----
  {
    files: ['platform/**', 'scripts/labs/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['platform/api/src/**/*.ts'],
    ignores: ['platform/api/src/dev/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [atlDevPattern] }] },
  },
  {
    files: ['platform/shared/src/**/*.ts', 'platform/workflows/src/**/*.ts', 'platform/web/src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [atlSdkPattern] }] },
  },
  {
    files: ['platform/api/src/domain/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [atlSdkPattern, atlDevPattern] }] },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  // ATL SPA (platform/web, 08-ui-design.md): browser code with React hooks rules; the dev launcher and configs run in Node
  {
    files: ['platform/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  // @atl/ssm-client: the protocol layer runs in the browser (no node:* imports); only src/mock/** is Node (platform-ssm-client)
  {
    files: ['platform/ssm-client/src/**/*.ts'],
    ignores: ['platform/ssm-client/src/mock/**'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*', 'ws', '@aws-sdk/*'], message: 'ATL: the ssm-client protocol layer is browser code (Node-only code belongs in src/mock/).' }] }],
    },
  },
);
