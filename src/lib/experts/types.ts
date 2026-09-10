// Experts mode — docs/superpowers/specs/2026-09-09-experts-mode-design.md
export type Tier = 'strong' | 'partial' | 'weak'

/** One WORK: an original searchable document plus its confirmed translations. */
export interface WorkRow {
  docId: string // original's external_id
  translations: string[] // external_ids of confirmed searchable translation rows
  title: string
  year: number | null
  type: string | null
  office: string | null // normalized on read (WRI México -> WRI Mexico)
  url: string | null
  /** Raw author strings in stored order: original's first, then translations' extras. */
  authorsRaw: string[]
  topics: string[] // accepted topic value_ids, union across rows
  geographies: string[] // accepted geography value_ids, union across rows
}

export interface MatchedTag {
  label: string
  cosine: number
  df: number
}

export interface RetrievedDoc {
  docId: string // as returned by /query (may be a translation's id)
  tier: Tier
  rank: number
}

export interface AuthorRef {
  key: string
  name: string
  org: boolean
  unverified?: boolean
}

export interface PersonTopic {
  label: string
  n: number
  matched: boolean
}

export interface PersonResult {
  key: string
  name: string
  office: string
  offices: Record<string, number>
  score: number
  evidence: {
    docs: number
    strong: number
    partial: number
    weak: number
    years: [number, number] | null
    corpusDocs: number
  }
  topics: PersonTopic[]
  docIds: string[]
  unverified?: boolean
}

export interface DocResult {
  docId: string
  title: string
  year: number | null
  type: string | null
  office: string | null
  tier: Tier | null
  url: string | null
  authors: AuthorRef[]
  topics: string[]
  geographies: string[]
  translations: string[]
}

export type RankMode = 'evidence' | 'topic_only'

export interface RankResult {
  mode: RankMode
  people: PersonResult[]
  totalPeople: number
  docs: Record<string, DocResult>
  organizations: { name: string; docs: number }[]
}

export interface ExpertsUnderstanding {
  matched_topics: MatchedTag[]
  matched_geographies: MatchedTag[]
  likely_off_topic: boolean
  suggestions: { type: string; text: string }[]
  degraded: string[]
}

export interface ExpertsResponse {
  ok: true
  query: string
  mode: RankMode
  understanding: ExpertsUnderstanding
  people: PersonResult[]
  total_people: number
  docs: Record<string, DocResult>
  organizations: { name: string; docs: number }[]
  usage: Record<string, unknown> | null
  timing: Record<string, number>
}

export interface ExpertsRequest {
  query: string
  excluded_topics?: string[]
  top_n?: number
}
