/** @jest-environment jsdom */
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { TopicTaxonomyManager } from '@/app/admin/topics/components/TopicTaxonomyManager'

// jsdom lacks IntersectionObserver — stub it so progressive-render code
// doesn't crash. Tests can capture the callback to simulate intersection.
let ioCallback: ((entries: { isIntersecting: boolean }[]) => void) | null = null
class MockIO {
  observe = jest.fn((_node: any) => {})
  unobserve = jest.fn()
  disconnect = jest.fn()
  takeRecords = jest.fn(() => [])
  root = null
  rootMargin = ''
  thresholds = []
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
    ioCallback = cb
  }
}
;(globalThis as any).IntersectionObserver = MockIO

const mockTags = [
  {
    id: 't1',
    facet: 'topic',
    valueId: 'Coal',
    taxonomyVersion: 'v1',
    parentTagId: null,
    description: 'Fossil fuel',
    aliases: ['Coal Industry'],
    acceptedCount: 12,
    suggestedCount: 3,
    needsReembed: false,
  },
  {
    id: 't2',
    facet: 'topic',
    valueId: 'Coal Combustion',
    taxonomyVersion: 'v1',
    parentTagId: 't1',
    description: 'Power generation',
    aliases: [],
    acceptedCount: 3,
    suggestedCount: 0,
    needsReembed: false,
  },
  {
    id: 't3',
    facet: 'topic',
    valueId: 'Climate',
    taxonomyVersion: 'v1',
    parentTagId: null,
    description: 'Long-term shifts in temperatures',
    aliases: ['Climate Change', 'Global Warming'],
    acceptedCount: 45,
    suggestedCount: 5,
    needsReembed: false,
  },
]

function mockFetch(tags: any[]) {
  global.fetch = jest.fn((url: string) => {
    if (url === '/api/admin/topics') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, tags }),
      }) as any
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any
  })
}

describe('TopicTaxonomyManager (jsdom)', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    ioCallback = null
  })

  it('renders heading and topic rows after load', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Topic taxonomy')).toBeTruthy()
      expect(screen.getByText('Coal')).toBeTruthy()
    })
    expect(screen.getByText('Climate')).toBeTruthy()
  })

  it('filters rows by search query (label + aliases + description)', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
    })
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Global Warming' } })
    await waitFor(() => {
      expect(screen.getByText('Climate')).toBeTruthy()
      expect(screen.queryByText('Coal')).toBeNull()
    })
  })

  it('shows error message on fetch failure', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: 'something went wrong' }),
      }) as any,
    )
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeTruthy()
    })
  })

  it('hides children when a tree node is collapsed', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    // Wait for load — both Coal and Coal Combustion should be visible (root expanded)
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
      expect(screen.getByText('Coal Combustion')).toBeTruthy()
    })

    // Click the collapse chevron on Coal (the root parent)
    const chevron = screen.getByText('▾')
    fireEvent.click(chevron)

    // Coal Combustion should now be hidden (collapsed)
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
      expect(screen.queryByText('Coal Combustion')).toBeNull()
    })

    // Click again to re-expand
    const chevron2 = screen.getByText('▸')
    fireEvent.click(chevron2)
    await waitFor(() => {
      expect(screen.getByText('Coal Combustion')).toBeTruthy()
    })
  })

  it('shows needs-re-embed stat chip when tags have needsReembed=true', async () => {
    const tagsWithReembed = [
      { ...mockTags[0], needsReembed: true },
      { ...mockTags[1], needsReembed: true },
      { ...mockTags[2], needsReembed: false },
    ]
    mockFetch(tagsWithReembed)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    // Wait for data to load (Coal is a data-dependent element)
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
    })
    // The stat chip should show "2 need re-embed"
    expect(screen.getByText(/need re-embed/i)).toBeTruthy()
  })

  it('does not show needs-re-embed stat when count is 0', async () => {
    mockFetch(mockTags) // all needsReembed: false
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
    })
    expect(screen.queryByText(/need re-embed/i)).toBeNull()
  })

  it('progressive render loads more rows when sentinel intersects', async () => {
    // Create >200 tags with zero-padded names so alphabetical sort = numerical
    const manyTags = Array.from({ length: 250 }, (_, i) => ({
      id: `tag-${i}`,
      facet: 'topic',
      valueId: `Topic ${String(i).padStart(3, '0')}`,
      taxonomyVersion: 'v1',
      parentTagId: null,
      description: null,
      aliases: [],
      acceptedCount: 0,
      suggestedCount: 0,
      needsReembed: false,
    }))

    mockFetch(manyTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )

    // Wait for load — first 200 should be visible (Topic 000 through Topic 199)
    await waitFor(() => {
      expect(screen.getByText('Topic 000')).toBeTruthy()
      expect(screen.getByText('Topic 199')).toBeTruthy()
    })

    // Topic 200 should NOT be visible yet (only 200 shown, zero-padded so alpha = numeric)
    expect(screen.queryByText('Topic 200')).toBeNull()

    // Fire the IO callback to simulate sentinel intersection
    expect(ioCallback).toBeTruthy()
    ioCallback!([{ isIntersecting: true }])

    // Now Topic 200 should be visible (200 more loaded)
    await waitFor(() => {
      expect(screen.getByText('Topic 200')).toBeTruthy()
    })
  })

  // ---- Task 14: Edit drawer ----

  it('opens edit drawer on row click with pre-filled fields', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
    })

    // Click the Coal row label to open the drawer
    fireEvent.click(screen.getByText('Coal'))

    // Drawer should appear with pre-filled fields
    await waitFor(() => {
      expect(screen.getByDisplayValue('Coal')).toBeTruthy()
      expect(screen.getByDisplayValue('Fossil fuel')).toBeTruthy()
      expect(screen.getByText('Coal Industry')).toBeTruthy() // alias chip
    })
  })

  it('saves edits via PATCH and shows success flash', async () => {
    let patchUrl = ''
    let patchBody: any = null
    global.fetch = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url.startsWith('/api/admin/topics/t1') && init?.method === 'PATCH') {
        patchUrl = url
        patchBody = JSON.parse(init.body)
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, tag: { ...mockTags[0], valueId: 'Coal Updated' } }),
        }) as any
      }
      if (url.startsWith('/api/admin/topics/t1') && init?.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tag: mockTags[0] }),
        }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })

    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    // Open drawer
    fireEvent.click(screen.getByText('Coal'))
    await waitFor(() => expect(screen.getByDisplayValue('Coal')).toBeTruthy())

    // Change label
    const labelInput = screen.getByDisplayValue('Coal') as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: 'Coal Updated' } })

    // Click Save
    fireEvent.click(screen.getByText('Save'))

    // Assert PATCH was called
    await waitFor(() => {
      expect(patchUrl).toBe('/api/admin/topics/t1')
      expect(patchBody.valueId).toBe('Coal Updated')
    })
  })

  it('shows inline parent error on cycle (409)', async () => {
    global.fetch = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url.startsWith('/api/admin/topics/t1') && init?.method === 'PATCH') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ ok: false, error: 'cycle' }),
        }) as any
      }
      if (url.startsWith('/api/admin/topics/t1') && init?.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tag: mockTags[0] }),
        }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })

    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    // Open drawer
    fireEvent.click(screen.getByText('Coal'))
    await waitFor(() => expect(screen.getByDisplayValue('Coal')).toBeTruthy())

    // Click Save (will trigger a cycle error)
    fireEvent.click(screen.getByText('Save'))

    // Should show inline cycle error on parent field (not top-of-drawer)
    await waitFor(() => {
      expect(screen.getByText(/cycle/i)).toBeTruthy()
    })
  })

  it('shows top-of-drawer error for non-cycle failure (500)', async () => {
    global.fetch = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url.startsWith('/api/admin/topics/t1') && init?.method === 'PATCH') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ ok: false, error: 'Internal server error' }),
        }) as any
      }
      if (url.startsWith('/api/admin/topics/t1') && init?.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tag: mockTags[0] }),
        }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })

    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    // Open drawer
    fireEvent.click(screen.getByText('Coal'))
    await waitFor(() => expect(screen.getByDisplayValue('Coal')).toBeTruthy())

    // Click Save (will trigger a 500 error)
    fireEvent.click(screen.getByText('Save'))

    // Should show error at top of drawer, NOT on parent field
    await waitFor(() => {
      expect(screen.getByText('Internal server error')).toBeTruthy()
    })
    // Parent field should NOT have an error
    const parentSection = screen.getByText('Parent topic')
    expect(parentSection.parentElement?.querySelector('[style*="C11101"]')).toBeNull()
  })

  // ---- Task 15: Bulk ops ----

  it('shows bulk actions bar with count when rows are selected', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    // Wait for ALL tags to appear (expanded effect must run so Coal Combustion is visible)
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
      expect(screen.getByText('Coal Combustion')).toBeTruthy()
      expect(screen.getByText('Climate')).toBeTruthy()
    })

    // Select Coal and Climate via their row checkboxes
    const checkboxes = screen.getAllByRole('checkbox')
    // [0] = select-all in header, [1] = Climate (alpha-sorted roots), [2] = Coal, [3] = Coal Combustion
    fireEvent.click(checkboxes[2]) // Coal
    fireEvent.click(checkboxes[1]) // Climate

    // Bulk bar should appear with count "2 selected"
    await waitFor(() => {
      expect(screen.getByText('2 selected')).toBeTruthy()
    })
    // Bulk action buttons should be visible
    expect(screen.getByText(/merge into/i)).toBeTruthy()
    expect(screen.getByText(/re-parent/i)).toBeTruthy()
    expect(screen.getByText(/delete unused/i)).toBeTruthy()
  })

  it('opens merge modal when Merge button is clicked', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
      expect(screen.getByText('Coal Combustion')).toBeTruthy()
    })

    // Select Coal Combustion
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[3]) // Coal Combustion

    // Click Merge button
    fireEvent.click(screen.getByText(/merge into/i))

    // Merge modal should appear with title containing topic count
    await waitFor(() => {
      expect(screen.getByText(/merge.*1.*topic/i)).toBeTruthy()
    })
  })

  it('calls merge endpoint with correct intoTagId', async () => {
    const mergeCalls: { url: string; body: any }[] = []
    global.fetch = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url.includes('/merge') && init?.method === 'POST') {
        mergeCalls.push({ url, body: JSON.parse(init.body) })
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, moved: 1 }),
        }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })

    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
      expect(screen.getByText('Coal Combustion')).toBeTruthy()
    })

    // Select Coal Combustion (t2)
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[3]) // Coal Combustion

    // Click Merge
    fireEvent.click(screen.getByText(/merge into/i))

    // Wait for modal and select target
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeTruthy()
    })

    // Select Coal (t1) as target
    const select = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 't1' } })

    // Click "Merge & re-classify" button
    fireEvent.click(screen.getByText(/merge.*re-classify/i))

    // Assert POST /merge was called
    await waitFor(() => {
      expect(mergeCalls.length).toBe(1)
      expect(mergeCalls[0].url).toContain('/api/admin/topics/t2/merge')
      expect(mergeCalls[0].body.intoTagId).toBe('t1')
    })
  })

  // ---- CSV import/export (Task 16) ----

  it('shows Import and Export buttons in the toolbar', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())
    expect(screen.getByText('Import CSV')).toBeTruthy()
    expect(screen.getByText('Export CSV')).toBeTruthy()
  })

  it('disables Apply button when dry-run has conflicts', async () => {
    global.fetch = jest.fn((url: string, _init?: any) => {
      const u = url.toString()
      if (u === '/api/admin/topics') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, tags: mockTags }) }) as any
      }
      if (u.startsWith('/api/admin/topics/import')) {
        if (u.includes('dry_run=true')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              ok: true,
              diff: {
                added: [{ label: 'NewTopic', description: '', aliases: [], parent: '', facet: 'topic', id: '' }],
                updated: [],
                unchanged: [],
                conflicts: [{ row: { label: 'BadRef', description: '', aliases: [], parent: 'NoSuch', facet: 'topic', id: '' }, reason: 'bad parent reference' }],
              },
            }),
          }) as any
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, applied: 1 }) }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })

    const csvContent = `label,description,aliases,parent,facet,id
NewTopic,,, ,topic,
BadRef,,,NoSuch,topic,
`
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' })

    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeTruthy()
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByText('1 added')).toBeTruthy()
      expect(screen.getByText('1 conflict')).toBeTruthy()
    })

    const applyBtn = screen.getByText('Apply 1 change')
    expect(applyBtn).toBeTruthy()
    expect((applyBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables Apply button when dry-run has no conflicts', async () => {
    global.fetch = jest.fn((url: string, _init?: any) => {
      const u = url.toString()
      if (u === '/api/admin/topics') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, tags: mockTags }) }) as any
      }
      if (u.startsWith('/api/admin/topics/import')) {
        if (u.includes('dry_run=true')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              ok: true,
              diff: {
                added: [{ label: 'NewTopic', description: 'desc', aliases: [], parent: '', facet: 'topic', id: '' }],
                updated: [],
                unchanged: [],
                conflicts: [],
              },
            }),
          }) as any
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, applied: 1 }) }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })

    const csvContent = `label,description,aliases,parent,facet,id
NewTopic,desc,, ,topic,
`
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' })

    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByText('1 added')).toBeTruthy()
      expect(screen.getByText('0 conflicts')).toBeTruthy()
    })

    const applyBtn = screen.getByText('Apply 1 change')
    expect(applyBtn).toBeTruthy()
    expect((applyBtn as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows history tab with audit entries', async () => {
    global.fetch = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url.startsWith('/api/admin/topics/t1') && init?.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tag: mockTags[0] }),
        }) as any
      }
      if (url.includes('/history')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            entries: [
              { at: '2026-01-01T00:00:00Z', action: 'tag_update', actor: 'admin', source: 'human', before: { valueId: 'Old' }, after: { valueId: 'Coal' } },
              { at: '2025-12-01T00:00:00Z', action: 'tag_create', actor: 'admin', source: 'human', before: null, after: { valueId: 'Old' } },
            ],
          }),
        }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })

    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    // Open drawer
    fireEvent.click(screen.getByText('Coal'))
    await waitFor(() => expect(screen.getByDisplayValue('Coal')).toBeTruthy())

    // Click History tab
    fireEvent.click(screen.getByText('History'))

    // Should show audit entries
    await waitFor(() => {
      expect(screen.getByText('tag_update')).toBeTruthy()
      expect(screen.getByText('tag_create')).toBeTruthy()
    })
  })

  // ---- Task 17: Re-classify panel + trigger bar ----

  it('shows Re-classify trigger buttons in the toolbar', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Re-classify all')).toBeTruthy()
      expect(screen.getByText('Scoped to topic…')).toBeTruthy()
    })
  })

  it('opens confirm modal with estCost when Re-classify all is clicked', async () => {
    global.fetch = jest.fn((url: string) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify' && (url as any).method !== 'GET') {
        // For POST reclassify
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, enqueued: 203, estCost: 0.17, runId: 'run-1' }),
        }) as any
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      }) as any
    })
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    // Click the Re-classify all button
    fireEvent.click(screen.getByText('Re-classify all'))

    // Confirm modal should show the estimated count + cost
    await waitFor(() => {
      expect(screen.getByText(/203/)).toBeTruthy()
      expect(screen.getByText(/\$0\.17/)).toBeTruthy()
      expect(screen.getByText('Start')).toBeTruthy()
    })
  })

  it('calls POST /reclassify when Re-classify all is clicked', async () => {
    const fetchMock = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify') {
        if (init?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true, enqueued: 203, estCost: 0.17, runId: 'run-1' }),
          }) as any
        }
        // GET status
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true, queued: 0, running: 0, done: 203, error: 0, recent: [] }),
          }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })
    global.fetch = fetchMock
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    // Click Re-classify all — this triggers POST /reclassify (estimate = enqueue)
    fireEvent.click(screen.getByText('Re-classify all'))

    // Verify POST /reclassify was called (estimate call IS the enqueue)
    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        ([u, init]: any) => u === '/api/admin/topics/reclassify' && init?.method === 'POST',
      )
      expect(postCalls.length).toBeGreaterThanOrEqual(1)
    })

    // Start button should be visible and clickable
    await waitFor(() => expect(screen.getByText('Start')).toBeTruthy())
  })

  it('displays reclassify status panel with recent runs', async () => {
    // Use fake timers to avoid waiting 5s for the polling interval
    jest.useFakeTimers()
    global.fetch = jest.fn((url: string) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true, queued: 47, running: 0, done: 156, error: 0,
            recent: [
              { runId: 'run-1', scope: 'all', total: 203, done: 156, error: 0, estCost: 0.17, createdAt: '2026-08-17T12:00:00Z' },
              { runId: 'run-2', scope: 't1', total: 12, done: 12, error: 0, estCost: 0.01, createdAt: '2026-08-17T11:00:00Z' },
            ],
          }),
        }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })

    const { unmount } = render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    // Wait for initial tags load
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    // Open the status panel — the useEffect immediately fetches status
    fireEvent.click(screen.getByText('Show jobs'))

    // With fake timers, fetch promises resolve on microtasks.
    // Use act() to flush them + trigger re-render.
    await act(async () => {
      jest.advanceTimersByTime(6000)
      await Promise.resolve()
    })

    // Status panel should show progress + recent runs
    expect(screen.getByText(/Re-classify jobs/i)).toBeTruthy()
    // The first recent run is 'Full corpus' with 203 total — appears in progress + recent
    expect(screen.getAllByText(/Full corpus/i).length).toBeGreaterThanOrEqual(1)

    unmount()
    jest.useRealTimers()
  })
})
