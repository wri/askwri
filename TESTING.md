# Testing Guide

## Quick Start

```bash
npm test                  # Run all tests
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage report
npm run test:ci           # CI mode
```

## Current Status

**Test Coverage:**
- ✅ PDF utilities: 13 tests passing
- ✅ CSV utilities: 3 tests passing
- ⏭️ Job queue: 24 tests skipped (async timing issues)

**Total:** 16 passing, 24 skipped

## Test Infrastructure

**Framework:**
- Jest with Next.js integration
- @edge-runtime/jest-environment (provides Web APIs)
- @testing-library/jest-dom (DOM matchers)

**Configuration** (`jest.config.js`):
```javascript
{
  testEnvironment: '@edge-runtime/jest-environment',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  coverageThreshold: { global: { branches: 70, functions: 70, lines: 70 } }
}
```

## Test Files

### `src/lib/__tests__/pdf-utils.test.ts`
- PDF header validation
- Text extraction (mocked pdfjs-dist)
- Metadata extraction
- Performance comparison

### `src/lib/__tests__/csv-utils.test.ts`
- Metadata interface validation
- Required/optional field handling
- Dynamic field support

### `src/lib/__tests__/job-queue.test.ts`
- All skipped (async timing + edge-runtime limitations)
- Covers: job creation, status tracking, processing workflow

### `src/__tests__/helpers/test-utils.tsx`
Helper utilities for creating mocks:
- `createMockRequest()` - NextRequest for API testing
- `createMockPDFBuffer()` - Minimal valid PDF
- `createMockMetadata()` - Document metadata
- `createMockCSVContent()` - CSV strings
- `createMockFormData()` - File uploads
- `mockFetchResponse()` - Fetch mocks
- `waitFor()` - Async condition waiting

## Known Limitations

**pdfjs-dist mocking:**
- Fully mocked in `jest.setup.js`
- Tests use fake PDF data, not real parsing
- Required due to ESM + `import.meta` incompatibility with Jest

**Edge runtime environment:**
- Provides Web APIs (Request, Response, Headers)
- Some Node.js APIs unavailable
- `jest.mock()` has limitations (no code generation from strings)

**Job queue tests:**
- Skipped due to async timing issues
- Edge-runtime fetch mocking complications
- Would need different test approach

**API route tests:**
- Not implemented
- Edge-runtime mocking limitations
- Would require integration test setup

## Writing Tests

### Basic Test
```typescript
import { myFunction } from '@/lib/my-utils';

describe('myFunction', () => {
  it('should do something', () => {
    expect(myFunction('input')).toBe('output');
  });
});
```

### API Route Test
```typescript
import { POST } from '@/app/api/my-route/route';
import { createMockRequest } from '@/__tests__/helpers/test-utils';

it('handles valid request', async () => {
  const request = createMockRequest({
    method: 'POST',
    body: { data: 'test' }
  });

  const response = await POST(request);
  expect(response.status).toBe(200);
});
```

### With Mocks
```typescript
import * as csvUtils from '@/lib/csv-utils';

jest.mock('@/lib/csv-utils');

beforeEach(() => {
  jest.clearAllMocks();
  (csvUtils.readCSV as jest.Mock).mockResolvedValue([...]);
});
```

## Running Specific Tests

```bash
# By file pattern
npm test -- --testPathPattern="pdf-utils"

# By test name
npm test -- --testNamePattern="should validate"

# With verbose output
npm test -- --verbose
```

## Coverage

View coverage report:
```bash
npm run test:coverage
open coverage/lcov-report/index.html
```

**Threshold:** 70% for branches, functions, lines, statements

## Debugging

### VS Code Launch Config
```json
{
  "type": "node",
  "request": "launch",
  "name": "Jest Debug",
  "program": "${workspaceFolder}/node_modules/.bin/jest",
  "args": ["--runInBand", "--no-cache"],
  "console": "integratedTerminal"
}
```

### Common Issues

**Tests hang:**
- Check for unmocked async operations
- Use `jest.useFakeTimers()` for timers

**Module not found:**
- Verify path aliases in `jest.config.js`
- Check case sensitivity

**Timeout errors:**
```typescript
it('slow test', async () => {
  // ...
}, 10000); // 10s timeout
```

**Mocks not working:**
```typescript
beforeEach(() => {
  jest.clearAllMocks(); // Clear between tests
});
```

## Future Improvements

**Not yet implemented:**
- React component tests
- End-to-end API tests
- Full workflow integration tests
- Snapshot testing

**To add UI tests:**
```typescript
import { render, screen } from '@testing-library/react';

it('renders component', () => {
  render(<MyComponent />);
  expect(screen.getByText('Hello')).toBeInTheDocument();
});
```
