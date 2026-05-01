import { dirname } from 'path'
import { fileURLToPath } from 'url'
import js from '@eslint/js'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'
import prettierConfig from 'eslint-config-prettier'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'coverage/**',
      'public/**',
      'next-env.d.ts',
      'search-service/**',
      'evaluation/results/**',
    ],
  },
  {
    // Files with blanket `/* eslint-disable */` comments may legitimately
    // suppress rules that don't currently fire; don't warn about that.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  js.configs.recommended,
  ...nextCoreWebVitals,
  ...nextTypescript,
  prettierConfig,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: __dirname,
      },
    },
  },
  {
    // Project-specific rules (preserved from legacy .eslintrc.js)
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'arrow-body-style': ['error', 'as-needed'],
      'import/prefer-default-export': 'off',
      'react/jsx-props-no-spreading': 'off',
      'import/no-useless-path-segments': [
        'error',
        { noUselessIndex: true },
      ],
      'prefer-arrow-callback': 'error',
      'react/jsx-no-duplicate-props': ['error', { ignoreCase: false }],
      'react/function-component-definition': [
        'error',
        { namedComponents: 'arrow-function' },
      ],
      'react/no-danger': 'off',
      'react/require-default-props': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'import/no-extraneous-dependencies': 'off',
      'react/no-unstable-nested-components': 'off',
      'import/extensions': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // `\-` inside regex character classes is harmless and idiomatic.
      'no-useless-escape': 'off',
      // Flat config is conventionally a default-exported anonymous array.
      'import/no-anonymous-default-export': 'off',
    },
  },
  {
    // CommonJS config files (jest.config.js, next.config.js, etc.)
    files: ['**/*.{js,cjs}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
]
