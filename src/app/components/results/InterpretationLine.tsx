'use client';

import React from 'react';
import { Tag } from '@worldresources/wri-design-systems';

export type FacetChip = { facet: string; value: string; label: string };

const LANGUAGE_NAMES: Record<string, string> = {
  es: 'Spanish', pt: 'Portuguese', zh: 'Chinese', en: 'English', id: 'Indonesian',
};

export function facetChipLabel(facet: string, value: string): string {
  if (facet === 'year_min') return `${value}–present`;
  if (facet === 'year_max') return `up to ${value}`;
  if (facet === 'language') return LANGUAGE_NAMES[value] ?? value;
  return value;
}

// Trust anchor (design §3): every hard facet the server applied is visible
// here and removable in one click. If this line is empty, nothing filtered.
export const InterpretationLine = ({
  chips,
  suggestion,
  onRemoveChip,
  onApplySuggestion,
}: {
  chips: FacetChip[];
  suggestion: string | null;
  onRemoveChip: (chip: FacetChip) => void;
  onApplySuggestion: (text: string) => void;
}) => {
  if (chips.length === 0 && !suggestion) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
      {chips.length > 0 && (
        <span style={{ fontSize: '14px', color: '#555' }}>Showing:</span>
      )}
      {chips.map((chip) => (
        <span key={`${chip.facet}:${chip.value}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
          <Tag label={chip.label} variant="info-grey" />
          <button
            aria-label={`Remove ${chip.label} filter`}
            onClick={() => onRemoveChip(chip)}
            style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '12px', color: '#555' }}
          >
            ✕
          </button>
        </span>
      ))}
      {suggestion && (
        <span style={{ fontSize: '14px' }}>
          Did you mean{' '}
          <button
            onClick={() => onApplySuggestion(suggestion)}
            style={{ color: '#0A6CFF', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: '14px' }}
          >
            {suggestion}
          </button>
          ?
        </span>
      )}
    </div>
  );
}
