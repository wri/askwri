/**
 * Faithful TS mirror of evaluation/eval-review/scripts/lookup_chunk_id.py's
 * normalize(): the harness scores verbatim text_snippet containment against
 * chunk text, and those snippets were resolved by the python tool — so both
 * sides must pass through the SAME normalization. Same character tables,
 * same operation order; do not adjust one side without the other.
 */

// OCR'd zh source text is inconsistent about full-width vs half-width
// punctuation even within the same document (observed directly in the python
// tool's work: the same sentence style appears with ASCII "," in some places
// and "，" in others). Fold both directions so matching doesn't depend on
// which variant either side happens to use. str.maketrans mirror — all 15
// source chars are single UTF-16 code units, so a plain code-unit loop is
// exact for arbitrary input.
//
//   python: "，。：；！？（）【】“”‘’—"   →   ",.:;!?()[]\"\"''-"
//   code:    U+FF0C U+3002 U+FF1A U+FF1B U+FF01 U+FF1F U+FF08 U+FF09
//            U+3010 U+3011 U+201C U+201D U+2018 U+2019 U+2014
const FULLWIDTH = '，。：；！？（）【】“”‘’—'
const HALFWIDTH = ',.:;!?()[]""\'\'-'

// Markdown emphasis characters a human/LLM might have accidentally carried
// over while copying a quote.
const MD_EMPHASIS_RE = /[*_#`]/g

const WHITESPACE_RE = /\s+/g

// The OCR'd text is also inconsistent about e.g. ", " vs "," after a comma —
// drop whitespace immediately around punctuation.
const SPACE_AROUND_PUNCT_RE = /\s*([,.:;!?()\[\]"'-])\s*/g

function foldFullwidth(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const to = FULLWIDTH.indexOf(text[i])
    out += to >= 0 ? HALFWIDTH[to] : text[i]
  }
  return out
}

export function normalize(text: string): string {
  text = text.replace(MD_EMPHASIS_RE, '')
  text = foldFullwidth(text)
  text = text.replace(WHITESPACE_RE, ' ')
  text = text.replace(SPACE_AROUND_PUNCT_RE, '$1')
  return text.trim().toLowerCase()
}

/** normalize(snippet) is a substring of normalize(chunkText). */
export function snippetContained(snippet: string, chunkText: string): boolean {
  return normalize(chunkText).includes(normalize(snippet))
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/

/** 'zh' when the text contains CJK codepoints, else 'latin'. */
export function langOf(text: string): 'zh' | 'latin' {
  return CJK_RE.test(text) ? 'zh' : 'latin'
}
