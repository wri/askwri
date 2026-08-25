const nextJest = require('next/jest')

const createJestConfig = nextJest({
  // Path to Next.js app
  dir: './',
})

/** @type {import('jest').Config} */
const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'jest-environment-jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // Worktrees are other checkouts of this repo. Without these, `npm test` run
  // from a tree that has one collects that branch's suites too: locally this
  // reported 88 suites where CI, on a fresh checkout, reported 45. Same class
  // of trap as the eslint `.worktrees` ignore.
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/.next/',
    '<rootDir>/.worktrees/',
    '<rootDir>/.claude/worktrees/',
  ],
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/layout.tsx',
  ],
}

module.exports = createJestConfig(customJestConfig)
