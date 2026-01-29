module.exports = {
  env: {
    browser: true,
  },
  extends: [
    'eslint:recommended',
    'airbnb',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/jsx-runtime',
    'airbnb-typescript',
    'prettier',
  ],
  plugins: ['@typescript-eslint'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./tsconfig.eslint.json'],
    tsconfigRootDir: __dirname,
  },
  rules: {
    '@typescript-eslint/no-unused-vars': 'error',
    // Require braces in arrow function body as needed
    'arrow-body-style': ['error', 'as-needed'],
    // Allow named exports from files with a single export
    'import/prefer-default-export': 'off',
    'react/jsx-props-no-spreading': 'off',
    // Disallow /index in imports
    'import/no-useless-path-segments': [
      'error',
      {
        noUselessIndex: true,
      },
    ],
    // Prefer arrow functions in callbacks
    'prefer-arrow-callback': 'error',
    'react/jsx-no-duplicate-props': [
      'error',
      {
        ignoreCase: false,
      },
    ],
    // Enforce function components being defined as arrow functions
    'react/function-component-definition': [
      'error',
      {
        namedComponents: 'arrow-function',
      },
    ],
    'react/no-danger': 0,
    'react/require-default-props': 0,
    '@typescript-eslint/no-explicit-any': 0,
    'import/no-extraneous-dependencies': 0,
    'react/no-unstable-nested-components': 0,
    'import/extensions': 0,
  },
}
