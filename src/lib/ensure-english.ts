// Detects LLM output that mirrored a non-English passage or query instead of
// following the "ALWAYS write in English" prompt rule (issues #387, #386).
// Checks for scripts that cannot be English (CJK, Cyrillic, Arabic, Hangul,
// Kana, Devanagari, Thai, Hebrew). ponytail: presence, not ratio — the
// reported failures are wholesale mirrors; romanized Chinese inside them
// defeats any Latin-vs-CJK ratio check. If Latin-script mirroring (Spanish/
// Portuguese) ever shows up, extend here.
const NON_ENGLISH_SCRIPT =
  // eslint-disable-next-line no-misleading-character-class -- detection only; standalone combining marks inside these blocks still count as non-English
  /[\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFB1D-\uFB4F]/

export function isEnglishText(text: unknown): boolean {
  return typeof text !== 'string' || !NON_ENGLISH_SCRIPT.test(text)
}
