/** @jest-environment jsdom */
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
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
    await act(async () => {
      ioCallback!([{ isIntersecting: true }])
    })

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

  it('shows descriptions and aliases together in topic rows', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )

    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())
    expect(screen.getByText('Fossil fuel')).toBeTruthy()
    expect(screen.getByText(/Coal Industry/)).toBeTruthy()
  })

  it('excludes the edited topic and all descendants from parent choices', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    fireEvent.click(screen.getByText('Coal'))

    const parentSelect = await screen.findByRole('combobox', { name: 'Parent topic' })
    expect(within(parentSelect).queryByRole('option', { name: 'Coal' })).toBeNull()
    expect(
      within(parentSelect).queryByRole('option', { name: 'Coal Combustion' }),
    ).toBeNull()
    expect(within(parentSelect).getByRole('option', { name: 'Climate' })).toBeTruthy()
  })

  it('closes the edit drawer on Escape when it is not busy', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())
    fireEvent.click(screen.getByText('Coal'))
    await screen.findByDisplayValue('Coal')

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByDisplayValue('Coal')).toBeNull()
  })

  it('creates a new topic with description, aliases, and parent, then closes with a flash', async () => {
    const createCalls: any[][] = []
    const fetchMock = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/topics' && init?.method === 'POST') {
        createCalls.push([url, init])
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            ok: true,
            tag: {
              ...mockTags[0],
              id: 't4',
              valueId: 'Methane',
              description: 'Short-lived climate pollutant',
              aliases: ['CH4'],
              parentTagId: 't3',
            },
          }),
        }) as any
      }
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
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

    fireEvent.click(screen.getByRole('button', { name: 'New topic' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Topic label' }), {
      target: { value: 'Methane' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Topic description' }), {
      target: { value: 'Short-lived climate pollutant' },
    })
    fireEvent.change(screen.getByPlaceholderText('Add alias…'), {
      target: { value: 'CH4' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add alias' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Parent topic' }), {
      target: { value: 't3' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create topic' }))

    await waitFor(() => {
      expect(createCalls).toHaveLength(1)
      expect(JSON.parse(createCalls[0][1].body)).toEqual({
        valueId: 'Methane',
        description: 'Short-lived climate pollutant',
        aliases: ['CH4'],
        parentTagId: 't3',
      })
      expect(screen.queryByRole('heading', { name: 'New topic' })).toBeNull()
      expect(screen.getByText('Topic created.')).toBeTruthy()
    })
  })

  it('rebuilds missing embeddings and reports the queued count', async () => {
    const fetchMock = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url === '/api/admin/topics/embeddings/rebuild' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, queued: 2 }),
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

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild embeddings' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/topics/embeddings/rebuild',
        { method: 'POST' },
      )
      expect(screen.getByText('Queued 2 topic embeddings for rebuild.')).toBeTruthy()
    })
  })

  it('filters topics by parent state, document count, and re-embed state', async () => {
    mockFetch([
      mockTags[0],
      { ...mockTags[1], needsReembed: true },
      mockTags[2],
    ])
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal Combustion')).toBeTruthy())

    fireEvent.change(screen.getByRole('combobox', { name: 'Parent state' }), {
      target: { value: 'child' },
    })
    expect(screen.getByText('Coal Combustion')).toBeTruthy()
    expect(screen.queryByText('Coal')).toBeNull()
    expect(screen.queryByText('Climate')).toBeNull()

    fireEvent.change(screen.getByRole('combobox', { name: 'Parent state' }), {
      target: { value: 'all' },
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minimum documents' }), {
      target: { value: '40' },
    })
    expect(screen.getByText('Climate')).toBeTruthy()
    expect(screen.queryByText('Coal')).toBeNull()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minimum documents' }), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Re-embed state' }), {
      target: { value: 'needed' },
    })
    expect(screen.getByText('Coal Combustion')).toBeTruthy()
    expect(screen.queryByText('Climate')).toBeNull()
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

  it('applies a successful import with the exact reclassify query parameter', async () => {
    const fetchMock = jest.fn((url: string, _init?: any) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url === '/api/admin/topics/import?dry_run=true') {
        return Promise.resolve({
          ok: true,
          status: 200,
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
      if (url === '/api/admin/topics/import?reclassify=true') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, applied: 1 }),
        }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })
    global.fetch = fetchMock

    const csvContent = `label,description,aliases,parent,facet,id
NewTopic,desc,,,topic,
`
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' })
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    })
    await screen.findByRole('button', { name: 'Apply 1 change' })

    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 change' }))

    await waitFor(() => {
      const applyCalls = fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === '/api/admin/topics/import?reclassify=true' &&
          init?.method === 'POST',
      )
      expect(applyCalls).toHaveLength(1)
      expect(applyCalls[0][1].headers).toEqual({ 'Content-Type': 'text/csv' })
      expect(applyCalls[0][1].body).toBe(csvContent)
    })
  })

  it('does not construct a download from a failed export response', async () => {
    const responseText = jest.fn(() => Promise.resolve('server failure'))
    global.fetch = jest.fn((url: string) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url === '/api/admin/topics/export') {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: responseText,
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
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => expect(screen.getByText('Export failed.')).toBeTruthy())
    expect(responseText).not.toHaveBeenCalled()
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

  it('uses GET to estimate full reclassification and cancel never enqueues', async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify?scope=all') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, eligible: 203, estCost: 0.17 }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify' && init?.method === 'POST') {
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
    global.fetch = fetchMock
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Re-classify all' }))

    await waitFor(() => {
      expect(screen.getByText(/203/)).toBeTruthy()
      expect(screen.getByText(/\$0\.17/)).toBeTruthy()
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/topics/reclassify?scope=all')
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === '/api/admin/topics/reclassify' && init?.method === 'POST',
      ),
    ).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === '/api/admin/topics/reclassify' && init?.method === 'POST',
      ),
    ).toHaveLength(0)
  })

  it('POSTs full reclassification exactly once on Start and reports the actual enqueue', async () => {
    const fetchMock = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify?scope=all') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, eligible: 203, estCost: 0.17 }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify') {
        if (init?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ok: true, enqueued: 201, estCost: 0.19, runId: 'run-1' }),
          }) as any
        }
      }
      if (url === '/api/admin/topics/reclassify/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true, queued: 201, running: 0, done: 0, error: 0, recent: [] }),
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

    fireEvent.click(screen.getByRole('button', { name: 'Re-classify all' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled())

    const postCallsBeforeStart = fetchMock.mock.calls.filter(
      ([url, init]: any) =>
        url === '/api/admin/topics/reclassify' && init?.method === 'POST',
    )
    expect(postCallsBeforeStart).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        ([url, init]: any) =>
          url === '/api/admin/topics/reclassify' && init?.method === 'POST',
      )
      expect(postCalls).toHaveLength(1)
      expect(JSON.parse(postCalls[0][1].body)).toEqual({ scope: 'all' })
      expect(screen.getByText(/Re-classify enqueued: 201 docs \(≈\$0\.1900\)/)).toBeTruthy()
    })
  })

  it('preserves tagId in scoped estimate and Start requests', async () => {
    const fetchMock = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify?tagId=t1') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, eligible: 12, estCost: 0.01 }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, enqueued: 11, estCost: 0.009, runId: 'run-scoped' }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, queued: 11, running: 0, done: 0, error: 0, recent: [] }),
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

    fireEvent.click(screen.getByRole('button', { name: 'Scoped to topic…' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Pick a topic' }), {
      target: { value: 't1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(screen.getByText(/12/)).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/topics/reclassify?tagId=t1')
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]: any) =>
          url === '/api/admin/topics/reclassify' && init?.method === 'POST',
      ),
    ).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        ([url, init]: any) =>
          url === '/api/admin/topics/reclassify' && init?.method === 'POST',
      )
      expect(postCalls).toHaveLength(1)
      expect(JSON.parse(postCalls[0][1].body)).toEqual({ tagId: 't1' })
    })
  })

  it('redirects to login when a reclassification estimate returns 401', async () => {
    const originalLocation = window.location
    delete (window as any).location
    ;(window as any).location = { href: '', pathname: '/admin/tags', search: '?facet=topic' }

    try {
      global.fetch = jest.fn((url: string) => {
        if (url === '/api/admin/topics') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true, tags: mockTags }),
          }) as any
        }
        if (url === '/api/admin/topics/reclassify?scope=all') {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: () => Promise.resolve({ ok: false, error: 'unauthorized' }),
          }) as any
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }) as any
      })

      render(
        <ChakraProvider>
          <TopicTaxonomyManager />
        </ChakraProvider>,
      )
      await waitFor(() => expect(screen.getByText('Coal')).toBeTruthy())

      fireEvent.click(screen.getByRole('button', { name: 'Re-classify all' }))

      await waitFor(() => {
        expect((window as any).location.href).toBe(
          '/admin/login?next=%2Fadmin%2Ftags%3Ffacet%3Dtopic',
        )
      })
    } finally {
      ;(window as any).location = originalLocation
    }
  })

  it('renders document-level details for failed reclassification jobs', async () => {
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
            ok: true,
            queued: 0,
            running: 0,
            done: 0,
            error: 1,
            recent: [
              {
                runId: '2cb8df76-60e1-4582-9839-082d512e4b57',
                scope: 'all',
                total: 1,
                done: 0,
                error: 1,
                estCost: 0.001,
                createdAt: '2026-08-17T12:00:00Z',
                updatedAt: '2026-08-17T12:01:00Z',
                errors: [
                  {
                    documentId: '77f1a7c6-6dba-4dc4-b10f-d62d9143b6bd',
                    externalId: 'WRI-42',
                    title: 'Climate report',
                    attempts: 2,
                    error: 'model timeout',
                  },
                ],
              },
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
    fireEvent.click(screen.getByRole('button', { name: 'Show jobs' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '1 error' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '1 error' }))

    expect(screen.getByText('Climate report')).toBeTruthy()
    expect(screen.getByText(/WRI-42/)).toBeTruthy()
    expect(screen.getByText(/attempts: 2/i)).toBeTruthy()
    expect(screen.getByText('model timeout')).toBeTruthy()
  })

  it('retries only the expanded failed run', async () => {
    const runId = '2cb8df76-60e1-4582-9839-082d512e4b57'
    const fetchMock = jest.fn((url: string, init?: any) => {
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
            ok: true,
            queued: 0,
            running: 0,
            done: 0,
            error: 1,
            recent: [
              {
                runId,
                scope: 'all',
                total: 1,
                done: 0,
                error: 1,
                estCost: 0.001,
                createdAt: '2026-08-17T12:00:00Z',
                updatedAt: '2026-08-17T12:01:00Z',
                errors: [],
              },
            ],
          }),
        }) as any
      }
      if (url === '/api/admin/topics/reclassify' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, enqueued: 1, estCost: 0.001, runId }),
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
    fireEvent.click(screen.getByRole('button', { name: 'Show jobs' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '1 error' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '1 error' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        ([url, init]: any) =>
          url === '/api/admin/topics/reclassify' && init?.method === 'POST',
      )
      expect(postCalls).toHaveLength(1)
      expect(JSON.parse(postCalls[0][1].body)).toEqual({ retryRunId: runId })
    })
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
