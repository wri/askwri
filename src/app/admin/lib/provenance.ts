export const PROVENANCE_BADGE: Record<
  string,
  { text: string; color: string; bg: string }
> = {
  human: { text: 'person', color: '#0A6640', bg: '#e4f2ea' },
  external: { text: 'imported', color: '#0050C8', bg: '#e6f0ff' },
  llm: { text: 'AI', color: '#8a5a15', bg: '#fdf3e0' },
}
