'use client'

import React from 'react'
import { Tag } from '@worldresources/wri-design-systems'
import { LANGUAGE_NAMES } from '@/app/utils/utils'

export type FacetChip = { facet: string; value: string; label: string }

type Facet = { facet: string; value: string; action: string }

/** The facets the server actually applied, in chip form. */
export const appliedChips = (facets?: Facet[] | null): FacetChip[] =>
  (facets ?? [])
    .filter((f) => f.action === 'hard')
    .map((f) => ({
      facet: f.facet,
      value: f.value,
      label: facetChipLabel(f.facet, f.value),
    }))

/** Suggested facets worth offering: the low-confidence tier the server never
 * applies. A facet the applied chips already cover is dropped, because the
 * sidecar routinely re-proposes what the parser already detected. */
export const suggestedChips = (
  facets?: Facet[] | null,
  applied: FacetChip[] = [],
): FacetChip[] => {
  // Keyed on the rendered label, not the raw value: the sidecar returns a
  // language NAME ("Chinese") where the parser returns the code ("zh"), and
  // both render as the same chip, so a value-only key would show it twice.
  const appliedLabels = new Set(applied.map((c) => `${c.facet}:${c.label}`))
  return (facets ?? [])
    .filter(
      (f) =>
        f.action === 'suggest' &&
        !appliedLabels.has(`${f.facet}:${facetChipLabel(f.facet, f.value)}`),
    )
    .map((f) => ({
      facet: f.facet,
      value: f.value,
      label: facetChipLabel(f.facet, f.value),
    }))
}

export function facetChipLabel(facet: string, value: string): string {
  if (facet === 'year_min') return `${value}–present`
  if (facet === 'year_max') return `up to ${value}`
  if (facet === 'language') return LANGUAGE_NAMES[value] ?? value
  return value
}

// Trust anchor (design §3): every hard facet the server applied is visible
// here and removable in one click. If this line is empty, nothing filtered.
export const InterpretationLine = ({
  chips,
  suggested = [],
  suggestion,
  onRemoveChip,
  onApplyChip,
  onApplySuggestion,
}: {
  chips: FacetChip[]
  suggested?: FacetChip[]
  suggestion: string | null
  onRemoveChip: (chip: FacetChip) => void
  onApplyChip?: (chip: FacetChip) => void
  onApplySuggestion: (text: string) => void
}) => {
  if (chips.length === 0 && suggested.length === 0 && !suggestion) return null
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        marginTop: '8px',
      }}
    >
      {chips.length > 0 && (
        <span style={{ fontSize: '14px', color: '#555' }}>Showing:</span>
      )}
      {chips.map((chip) => (
        <span
          key={`${chip.facet}:${chip.value}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}
        >
          <Tag label={chip.label} variant='info-grey' />
          <button
            aria-label={`Remove ${chip.label} filter`}
            onClick={() => onRemoveChip(chip)}
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontSize: '12px',
              color: '#555',
            }}
          >
            ✕
          </button>
        </span>
      ))}
      {suggested.length > 0 && (
        <span style={{ fontSize: '14px', color: '#555' }}>Suggested:</span>
      )}
      {suggested.map((chip) => (
        <button
          key={`suggest:${chip.facet}:${chip.value}`}
          aria-label={`Apply ${chip.label} filter`}
          title='Not applied. Click to filter by this.'
          onClick={() => onApplyChip?.(chip)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: 0,
            background: 'none',
            border: '1px dashed #9aa5b1',
            borderRadius: '16px',
            cursor: 'pointer',
          }}
        >
          <Tag label={chip.label} variant='info-white' />
        </button>
      ))}
      {suggestion && (
        <span style={{ fontSize: '14px' }}>
          Did you mean{' '}
          <button
            onClick={() => onApplySuggestion(suggestion)}
            style={{
              color: '#0A6CFF',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 0,
              fontSize: '14px',
            }}
          >
            {suggestion}
          </button>
          ?
        </span>
      )}
    </div>
  )
}
