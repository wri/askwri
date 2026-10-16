import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import FilterPanel, { type FilterPanelProps } from '../FilterPanel'

jest.mock('../filterOptions', () => ({
  getLanguageOptions: jest.fn().mockResolvedValue([
    { name: 'en', value: 'en', children: 'English' },
    { name: 'es', value: 'es', children: 'Spanish' },
    { name: 'zh', value: 'zh', children: 'Chinese' },
  ]),
  getOfficeOptions: jest.fn().mockResolvedValue([
    { name: 'wri-china', value: 'WRI China', children: 'China' },
    { name: 'wri-india', value: 'WRI India', children: 'India' },
    { name: 'wri-mexico', value: 'WRI Mexico', children: 'Mexico' },
  ]),
}))

const checkbox = (name: string) => screen.getByRole('checkbox', { name })

const toggleOffice = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByText(name).closest('label')!)
  })
}

const renderPanel = (overrides: Partial<FilterPanelProps> = {}) => {
  const props: FilterPanelProps = {
    open: true,
    selectedOffices: [],
    selectedLanguages: [],
    selectedDates: ['', ''],
    selectedRelevance: '',
    onApply: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  }
  const ui = (nextProps: FilterPanelProps) => (
    <ChakraProvider>
      <FilterPanel {...nextProps} />
    </ChakraProvider>
  )
  const view = render(ui(props))
  return {
    ...props,
    rerenderPanel: (changes: Partial<FilterPanelProps>) => {
      Object.assign(props, changes)
      view.rerender(ui(props))
    },
  }
}

describe('FilterPanel office interactions', () => {
  it('renders no modal while closed', () => {
    renderPanel({ open: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('preselects multiple URL offices regardless of case or accents', async () => {
    const params = new URLSearchParams(
      'office=WRI+India&office=wri+M%C3%A9xico',
    )
    renderPanel({ selectedOffices: params.getAll('office') })

    await waitFor(() => expect(checkbox('Mexico')).toBeChecked())
    expect(checkbox('India')).toBeChecked()
    expect(checkbox('China')).not.toBeChecked()
  })

  it('applies multiple offices and closes', async () => {
    const { onApply, onClose } = renderPanel({
      selectedOffices: ['WRI India'],
    })
    await waitFor(() => expect(checkbox('India')).toBeChecked())

    await toggleOffice('China')
    expect(checkbox('China')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith(
      ['WRI China', 'WRI India'],
      [],
      ['', ''],
      '',
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('applies an empty selection after unchecking the last office', async () => {
    const { onApply } = renderPanel({ selectedOffices: ['WRI India'] })
    await waitFor(() => expect(checkbox('India')).toBeChecked())

    await toggleOffice('India')
    expect(checkbox('India')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith([], [], ['', ''], '')
  })

  it('clears applied offices and draft edits, then closes', async () => {
    const { onApply, onClose } = renderPanel({
      selectedOffices: ['WRI India', 'WRI Mexico'],
      selectedDates: ['2020-06-01', '2020-06-30'],
    })
    await waitFor(() => expect(checkbox('Mexico')).toBeChecked())
    await toggleOffice('China')

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(onApply).toHaveBeenCalledWith([], [], ['', ''], '')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preselects URL languages and applies multiple codes', async () => {
    const { onApply, onClose } = renderPanel({
      selectedLanguages: ['es'],
    })
    await waitFor(() => expect(checkbox('Spanish')).toBeChecked())

    await toggleOffice('Chinese')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith([], ['es', 'zh'], ['', ''], '')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preselects URL dates and applies them with the other filters', async () => {
    const { onApply } = renderPanel({
      selectedOffices: ['WRI India'],
      selectedLanguages: ['es'],
      selectedDates: ['2020-06-01', '2020-06-30'],
    })
    await waitFor(() => expect(checkbox('India')).toBeChecked())
    expect(
      screen.getByRole('textbox', { name: 'Publication start date' }),
    ).toHaveValue('2020-06-01')
    expect(
      screen.getByRole('textbox', { name: 'Publication end date' }),
    ).toHaveValue('2020-06-30')

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith(
      ['WRI India'],
      ['es'],
      ['2020-06-01', '2020-06-30'],
      '',
    )
  })

  it('keeps an upper-bound-only range in the end slot on Apply', async () => {
    const { onApply } = renderPanel({ selectedDates: ['', '2020-06-30'] })

    expect(
      screen.getByRole('textbox', { name: 'Publication start date' }),
    ).toHaveValue('')
    expect(
      screen.getByRole('textbox', { name: 'Publication end date' }),
    ).toHaveValue('2020-06-30')

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    // Regression: filtering the missing start out of a compacted array moved
    // the end date to index 0, so Apply rewrote date_max as date_min.
    expect(onApply).toHaveBeenCalledWith([], [], ['', '2020-06-30'], '')
  })

  it('clears the upper bound when the end input is emptied', async () => {
    const { onApply } = renderPanel({ selectedDates: ['', '2020-06-30'] })
    await act(async () => {
      const end = screen.getByRole('textbox', { name: 'Publication end date' })
      fireEvent.change(end, { target: { value: '' } })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith([], [], ['', ''], '')
  })

  it('never applies the hidden sentinel start', async () => {
    const { onApply } = renderPanel({ selectedDates: ['', '2020-06-30'] })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    // The sentinel is scratch state for the picker only, never a real bound.
    const [, , dates] = (onApply as jest.Mock).mock.calls[0]
    expect(dates[0]).toBe('')
  })

  it('applies a lower-bound-only range in the start slot', async () => {
    const { onApply } = renderPanel({ selectedDates: ['2020-06-01', ''] })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith([], [], ['2020-06-01', ''], '')
  })

  // The sentinel is 1900-01-01, so keeping a date *before* it would let the
  // picker derive a `min` below the sentinel and undo the point of the sentinel.
  it('drops a pre-sentinel start bound on Apply', async () => {
    const { onApply } = renderPanel({
      selectedDates: ['1500-01-01', '2020-06-30'],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith([], [], ['', '2020-06-30'], '')
  })

  it('drops a pre-sentinel end bound from the picker', async () => {
    renderPanel({ selectedDates: ['', '1500-01-01'] })

    expect(
      screen.getByRole('textbox', { name: 'Publication end date' }),
    ).toHaveValue('')
  })

  it('applies a start edited onto an upper-bound-only range', async () => {
    const { onApply } = renderPanel({ selectedDates: ['', '2020-06-30'] })
    await act(async () => {
      const start = screen.getByRole('textbox', {
        name: 'Publication start date',
      })
      fireEvent.change(start, { target: { value: '2020-06-01' } })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith(
      [],
      [],
      ['2020-06-01', '2020-06-30'],
      '',
    )
  })

  it('applies an edited publication date range as ISO dates', async () => {
    const { onApply, rerenderPanel } = renderPanel({
      selectedDates: ['2020-06-01', '2020-06-30'],
    })
    await act(async () => {
      const end = screen.getByRole('textbox', { name: 'Publication end date' })
      fireEvent.change(end, { target: { value: '2020-07-31' } })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenCalledWith(
      [],
      [],
      ['2020-06-01', '2020-07-31'],
      '',
    )

    rerenderPanel({ open: false })
    rerenderPanel({ open: true })
    expect(
      screen.getByRole('textbox', { name: 'Publication end date' }),
    ).toHaveValue('2020-06-30')
  })

  it('ignores invalid URL dates when opening the picker', () => {
    renderPanel({ selectedDates: ['not-a-date'] })
    expect(
      screen.getByRole('textbox', { name: 'Publication start date' }),
    ).toHaveValue('')
  })

  it('discards canceled edits and uses the latest URL offices on reopening', async () => {
    const { onApply, onClose, rerenderPanel } = renderPanel({
      selectedOffices: ['WRI India'],
    })
    await waitFor(() => expect(checkbox('India')).toBeChecked())
    await toggleOffice('China')
    expect(checkbox('China')).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onApply).not.toHaveBeenCalled()
    rerenderPanel({ open: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    rerenderPanel({ open: true })
    await waitFor(() => expect(checkbox('India')).toBeChecked())
    expect(checkbox('China')).not.toBeChecked()

    rerenderPanel({ open: false, selectedOffices: ['WRI Mexico'] })
    rerenderPanel({ open: true })
    await waitFor(() => expect(checkbox('Mexico')).toBeChecked())
    expect(checkbox('India')).not.toBeChecked()
    expect(checkbox('China')).not.toBeChecked()
  })

  it('applies a selected relevance tier alongside the other filters', async () => {
    const { onApply, onClose } = renderPanel({
      selectedOffices: ['WRI India'],
      selectedDates: ['2020-06-01', ''],
    })
    await waitFor(() => expect(checkbox('India')).toBeChecked())

    // Zag's Select only wires change events through its hidden native
    // <select> in jsdom; the styled trigger/items don't respond to clicks.
    await act(async () => {
      fireEvent.change(document.querySelector('select[aria-hidden="true"]')!, {
        target: { value: 'strong' },
      })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith(
      ['WRI India'],
      [],
      ['2020-06-01', ''],
      'strong',
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preselects the URL relevance tier and applies a changed one', async () => {
    const { onApply } = renderPanel({ selectedRelevance: 'strong' })

    expect(
      screen.getByRole('combobox', { name: 'Select input' }),
    ).toHaveTextContent('Strong')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith([], [], ['', ''], 'strong')
  })

  it('clears the relevance draft when reopening the panel', async () => {
    const { onApply, rerenderPanel } = renderPanel({
      selectedRelevance: 'strong',
    })
    expect(
      screen.getByRole('combobox', { name: 'Select input' }),
    ).toHaveTextContent('Strong')

    rerenderPanel({ open: false })
    rerenderPanel({ open: true, selectedRelevance: '' })
    expect(
      screen.getByRole('combobox', { name: 'Select input' }),
    ).toHaveTextContent('Please select')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith([], [], ['', ''], '')
  })
})
