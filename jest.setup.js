// Learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom'

// Mock environment variables for tests
process.env.OPENAI_API_KEY = 'sk-test-key'
process.env.LLAMAINDEX_SERVICE_URL = 'http://localhost:8002'

// Mock fetch globally (override edge-runtime's fetch)
const originalFetch = global.fetch
global.fetch = jest.fn()

// Mock pdfjs-dist
jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: jest.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getMetadata: () => Promise.resolve({
        info: {
          Title: 'Test PDF',
          Author: 'Test Author',
          Subject: 'Test Subject',
          Keywords: 'test, pdf',
          Creator: 'Test Creator',
          Producer: 'Test Producer',
          CreationDate: '2024-01-01',
        },
      }),
      getPage: (pageNum) => Promise.resolve({
        getTextContent: () => Promise.resolve({
          items: [
            { str: 'Test' },
            { str: 'PDF' },
            { str: 'content' },
          ],
        }),
      }),
    }),
  })),
}))

// Reset mocks after each test
afterEach(() => {
  jest.clearAllMocks()
})