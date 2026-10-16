import antfu from '@antfu/eslint-config'
import prettier from 'eslint-config-prettier'

export default antfu(
  {
    ignores: ['**/node_modules/**', '**/.vite/**', '**/out/**', '**/dist/**', '**/*.md', 'pnpm-lock.yaml'],
    typescript: true,
    formatters: false,
    markdown: false,
    node: false,
    test: false,
    rules: {
      'antfu/if-newline': 'off',
      'antfu/curly': 'off',
      curly: ['error', 'all'],
      'style/lines-between-class-members': 'off',
      'antfu/consistent-list-newline': 'off',
      'antfu/no-top-level-await': 'off',
      'import/consistent-type-specifier-style': 'off',
      'jsonc/sort-keys': 'off',
      'no-alert': 'off',
      'no-console': 'off',
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-named-imports': 'off',
      'pnpm/json-enforce-catalog': 'off',
      'pnpm/yaml-enforce-settings': 'off',
      'regexp/use-ignore-case': 'off',
      'ts/consistent-type-definitions': 'off',
      'yaml/quotes': 'off',
    },
  },
  {
    files: [
      'apps/desktop/src/main/**/*.ts',
      'apps/desktop/tests/**/*.ts',
      'apps/desktop/*.config.mts',
      'packages/*/src/main/**/*.ts',
      'packages/*/src/shared/**/*.ts',
      'packages/*/tests/**/*.ts',
      'packages/*/tests/**/*.tsx',
      'tests/**/*.ts',
      'scripts/test.mts',
      '*.config.mts',
      'packages/pi-runtime/src/**/*.ts',
      'packages/{host,pi-adapter,plugin-runtime,plugin-devkit}/src/**/*.{ts,mts}',
      'packages/*/src/{server,agent,shared}/**/*.ts',
      'plugins/*/src/{server,agent,shared}/**/*.ts',
      'plugins/*/tests/**/*.ts',
      'apps/server/**/*.{ts,mts}',
      'apps/web/*.config.mts',
      'scripts/**/*.{mjs,mts}',
      '*.config.{js,mjs}',
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        module: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    files: [
      'apps/desktop/src/renderer/**/*.{ts,tsx}',
      'packages/*/src/renderer/**/*.{ts,tsx}',
      'packages/{client,app-ui}/src/**/*.{ts,tsx}',
      'apps/web/src/**/*.{ts,tsx}',
      'packages/*/tests/**/*.component.test.tsx',
      'tests/fixtures/component-setup.ts',
      'packages/*/src/ui/**/*.{ts,tsx}',
      'plugins/*/src/ui/**/*.{ts,tsx}',
    ],
    languageOptions: { globals: { window: 'readonly', document: 'readonly', HTMLElement: 'readonly' } },
  },
  { files: ['apps/desktop/src/preload/**/*.ts'], languageOptions: { globals: { Electron: 'readonly' } } },
  {
    files: [
      'packages/{chat,workspace,history,models,settings,resources,interaction,subagents,mcp,codemode,permissions,sandbox-macos,sandbox-linux,usage,git,file-directory,terminal}/src/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@pi-meme/{chat,workspace,history,models,settings,resources,pi-extensions,subagents,mcp,codemode,permissions,sandbox-macos,sandbox-linux,usage,git,file-directory,terminal}',
                '@pi-meme/{chat,workspace,history,models,settings,resources,pi-extensions,subagents,mcp,codemode,permissions,sandbox-macos,sandbox-linux,usage,git,file-directory,terminal}/**',
              ],
              message: '业务包之间通过契约、Props 或服务通信，由 Host 和 app-ui 装配。',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'packages/*/src/renderer/**/*.{ts,tsx}',
      'packages/{client,app-ui}/src/**/*.{ts,tsx}',
      'apps/web/src/**/*.{ts,tsx}',
      'packages/*/src/ui/**/*.{ts,tsx}',
      'plugins/*/src/ui/**/*.{ts,tsx}',
      'apps/desktop/src/renderer/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'electron', 'electron/*'], message: 'UI 不导入 Node.js 或 Electron 模块。' },
            {
              group: ['@pi-meme/*/server/**', '@pi-meme/*/agent/**', '../server/**', '../agent/**'],
              message: 'UI 不导入 Server 或 Agent 实现。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'react', 'react-dom', '@pi-meme/*'], message: 'contracts 只放纯类型契约。' },
          ],
        },
      ],
    },
  },
  prettier,
)
