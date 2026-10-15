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
    selectedDates: [],
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

    expect(onApply).toHaveBeenCalledWith(['WRI China', 'WRI India'], [], [])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('applies an empty selection after unchecking the last office', async () => {
    const { onApply } = renderPanel({ selectedOffices: ['WRI India'] })
    await waitFor(() => expect(checkbox('India')).toBeChecked())

    await toggleOffice('India')
    expect(checkbox('India')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith([], [], [])
  })

  it('clears applied offices and draft edits, then closes', async () => {
    const { onApply, onClose } = renderPanel({
      selectedOffices: ['WRI India', 'WRI Mexico'],
      selectedDates: ['2020-06-01', '2020-06-30'],
    })
    await waitFor(() => expect(checkbox('Mexico')).toBeChecked())
    await toggleOffice('China')

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(onApply).toHaveBeenCalledWith([], [], [])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preselects URL languages and applies multiple codes', async () => {
    const { onApply, onClose } = renderPanel({
      selectedLanguages: ['es'],
    })
    await waitFor(() => expect(checkbox('Spanish')).toBeChecked())

    await toggleOffice('Chinese')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApply).toHaveBeenCalledWith([], ['es', 'zh'], [])
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
    expect(onApply).toHaveBeenCalledWith([], [], ['2020-06-01', '2020-07-31'])

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
})
