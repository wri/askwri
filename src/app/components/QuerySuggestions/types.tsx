export interface QuerySuggestionsProps {
  mode: 'cite' | 'answer' | 'experts'
  onExampleClick: (example: string) => void
}
