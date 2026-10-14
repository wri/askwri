import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import FilterPanel, { type FilterPanelProps } from '../FilterPanel'

jest.mock('../filterOptions', () => ({
  getLanguageOptions: jest.fn().mockResolvedValue([]),
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
    onClose: jest.fn(),
    onApplyOffices: jest.fn(),
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
    const { onApplyOffices, onClose } = renderPanel({
      selectedOffices: ['WRI India'],
    })
    await waitFor(() => expect(checkbox('India')).toBeChecked())

    await toggleOffice('China')
    expect(checkbox('China')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApplyOffices).toHaveBeenCalledWith(['WRI China', 'WRI India'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('applies an empty selection after unchecking the last office', async () => {
    const { onApplyOffices } = renderPanel({ selectedOffices: ['WRI India'] })
    await waitFor(() => expect(checkbox('India')).toBeChecked())

    await toggleOffice('India')
    expect(checkbox('India')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onApplyOffices).toHaveBeenCalledWith([])
  })

  it('clears applied offices and draft edits, then closes', async () => {
    const { onApplyOffices, onClose } = renderPanel({
      selectedOffices: ['WRI India', 'WRI Mexico'],
    })
    await waitFor(() => expect(checkbox('Mexico')).toBeChecked())
    await toggleOffice('China')

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(onApplyOffices).toHaveBeenCalledWith([])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('discards canceled edits and uses the latest URL offices on reopening', async () => {
    const { onApplyOffices, onClose, rerenderPanel } = renderPanel({
      selectedOffices: ['WRI India'],
    })
    await waitFor(() => expect(checkbox('India')).toBeChecked())
    await toggleOffice('China')
    expect(checkbox('China')).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onApplyOffices).not.toHaveBeenCalled()
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
