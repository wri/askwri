/**
 * Test utilities and helpers
 */

import { NextRequest } from 'next/server';

/**
 * Create a mock NextRequest for testing API routes
 */
export function createMockRequest(options: {
  method?: string;
  url?: string;
  body?: any;
  headers?: Record<string, string>;
}): NextRequest {
  const {
    method = 'GET',
    url = 'http://localhost:3000/api/test',
    body,
    headers = {},
  } = options;

  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    init.body = JSON.stringify(body);
  }

  // NextRequest constructor expects specific types, cast to satisfy TypeScript
  return new NextRequest(url, init as any);
}

/**
 * Create mock FormData for file uploads
 */
export function createMockFormData(options: {
  files?: Array<{ name: string; content: string; type: string }>;
  fields?: Record<string, string>;
}): FormData {
  const formData = new FormData();

  if (options.files) {
    options.files.forEach(file => {
      const blob = new Blob([file.content], { type: file.type });
      formData.append('files', blob, file.name);
    });
  }

  if (options.fields) {
    Object.entries(options.fields).forEach(([key, value]) => {
      formData.append(key, value);
    });
  }

  return formData;
}

/**
 * Mock fetch response
 */
export function mockFetchResponse(data: any, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response);
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean,
  timeout = 5000,
  interval = 100
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/**
 * Create a mock PDF buffer
 */
export function createMockPDFBuffer(): Buffer {
  // Minimal valid PDF structure
  const pdfContent = `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj
2 0 obj
<<
/Type /Pages
/Count 1
/Kids [3 0 R]
>>
endobj
3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Contents 4 0 R
/Resources <<
/Font <<
/F1 <<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica
>>
>>
>>
>>
endobj
4 0 obj
<<
/Length 44
>>
stream
BT
/F1 12 Tf
100 700 Td
(Test PDF) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f
0000000015 00000 n
0000000068 00000 n
0000000125 00000 n
0000000324 00000 n
trailer
<<
/Size 5
/Root 1 0 R
>>
startxref
420
%%EOF`;

  return Buffer.from(pdfContent);
}

/**
 * Create mock document metadata
 */
export function createMockMetadata(overrides?: Partial<any>) {
  return {
    'Article Title': 'Test Document',
    'All authors': 'Smith, J.; Doe, A.',
    'YEAR accepted': 2024,
    'Source URL': 'https://example.com/test.pdf',
    'Sub-tag': 'Transport decarbonization',
    ...overrides,
  };
}

/**
 * Create mock CSV content
 */
export function createMockCSVContent(rows: number = 3): string {
  const header = 'file_path,metadata,summary';
  const dataRows = Array.from({ length: rows }, (_, i) => {
    const metadata = JSON.stringify(createMockMetadata({
      'Article Title': `Document ${i}`,
    })).replace(/"/g, '""');
    return `doc_${i}.pdf,"${metadata}","Test summary for document ${i}"`;
  });

  return [header, ...dataRows].join('\n');
}