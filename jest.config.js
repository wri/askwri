const nextJest = require('next/jest')

const createJestConfig = nextJest({
  // Path to Next.js app
  dir: './',
})

/** @type {import('jest').Config} */
const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // d3-force ships ESM only ("type": "module", main = src/index.js). next/jest
  // hard-codes a blanket node_modules ignore and only APPENDS custom
  // transformIgnorePatterns afterwards (Jest ignores a file if ANY pattern
  // matches), so a custom ignore exception can never un-ignore it — and a
  // root-anchored exception would RE-ignore jose/next ESM paths that next/jest
  // deliberately exempts, breaking their suites. Map the d3 packages to their
  // bundled UMD dists (plain CJS, no transform needed) instead.
  //
  // Two tidier-looking alternatives were tried and REJECTED with evidence
  // (2026-09-09); do not reintroduce either:
  //   - require.resolve('d3-force/dist/d3-force.js') throws, because d3's
  //     exports map only publishes "umd" and "default" — the dist path is not
  //     an addressable subpath.
  //   - testEnvironmentOptions.customExportConditions: ['umd', 'browser'],
  //     which would let each package name its own UMD build, activates "umd"
  //     for EVERY package: @aws-sdk/checksums then resolves to an ESM build and
  //     5 suites die on `SyntaxError: Unexpected token 'export'`.
  // The <rootDir> paths below are layout-dependent by construction, which is
  // the accepted cost; `npm ci` produces the flat layout they assume.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^d3-force$': '<rootDir>/node_modules/d3-force/dist/d3-force.js',
    '^d3-quadtree$': '<rootDir>/node_modules/d3-quadtree/dist/d3-quadtree.js',
    '^d3-dispatch$': '<rootDir>/node_modules/d3-dispatch/dist/d3-dispatch.js',
    '^d3-timer$': '<rootDir>/node_modules/d3-timer/dist/d3-timer.js',
  },
  testEnvironment: 'jest-environment-jsdom',
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
