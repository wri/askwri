import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChakraProvider from '@/app/Providers/ChakraProvider';
import { InterpretationLine, facetChipLabel } from '../InterpretationLine';

describe('facetChipLabel', () => {
  it('formats year and language facets for humans', () => {
    expect(facetChipLabel('year_min', '2022')).toBe('2022–present');
    expect(facetChipLabel('year_max', '2019')).toBe('up to 2019');
    expect(facetChipLabel('language', 'es')).toBe('Spanish');
    expect(facetChipLabel('program', 'WRR')).toBe('WRR');
  });
});

describe('InterpretationLine', () => {
  const chips = [{ facet: 'year_min', value: '2022', label: '2022–present' }];

  it('renders nothing when there is nothing to say', () => {
    const { container } = render(
      <InterpretationLine chips={[]} suggestion={null} onRemoveChip={jest.fn()} onApplySuggestion={jest.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders removable chips and fires onRemoveChip', () => {
    const onRemove = jest.fn();
    render(
      <ChakraProvider>
        <InterpretationLine chips={chips} suggestion={null} onRemoveChip={onRemove} onApplySuggestion={jest.fn()} />
      </ChakraProvider>
    );
    expect(screen.getByText('2022–present')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove 2022–present filter'));
    expect(onRemove).toHaveBeenCalledWith(chips[0]);
  });

  it('renders a did-you-mean suggestion and fires onApplySuggestion', () => {
    const onApply = jest.fn();
    render(
      <InterpretationLine chips={[]} suggestion="freight decarbonization" onRemoveChip={jest.fn()} onApplySuggestion={onApply} />
    );
    fireEvent.click(screen.getByText('freight decarbonization'));
    expect(onApply).toHaveBeenCalledWith('freight decarbonization');
  });
});
