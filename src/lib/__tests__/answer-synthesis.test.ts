import { resolveSynthesisConfig } from '@/lib/answer-synthesis'

/**
 * The 2026-09-10 default change (§10.4-confirmed): gpt-5 models send
 * 15 passages × 800 chars by default (was 8 × 400); non-gpt-5 models keep
 * 6 × 350. The eval harness's --knob overrides still win, and the caps still
 * apply.
 */
describe('resolveSynthesisConfig synthesis defaults', () => {
  it('gpt-5 models default to 15 passages × 800 chars', () => {
    const cfg = resolveSynthesisConfig({})
    // DEFAULT_MODEL falls back to gpt-5.4 when OPENAI_MODEL is unset
    expect(cfg.maxPassages).toBe(15)
    expect(cfg.passageChars).toBe(800)
  })

  it('non-gpt-5 models keep 6 passages × 350 chars', () => {
    const cfg = resolveSynthesisConfig({ model: 'gpt-4o-mini' })
    expect(cfg.maxPassages).toBe(6)
    expect(cfg.passageChars).toBe(350)
  })

  it('explicit knobs still override the defaults', () => {
    const cfg = resolveSynthesisConfig({ max_passages: 8, passage_chars: 400 })
    expect(cfg.maxPassages).toBe(8)
    expect(cfg.passageChars).toBe(400)
  })

  it('knob caps still apply', () => {
    const cfg = resolveSynthesisConfig({
      max_passages: 999,
      passage_chars: 999_999,
    })
    expect(cfg.maxPassages).toBe(15) // MAX_PASSAGES_CAP
    expect(cfg.passageChars).toBe(20_000)
  })

  it('prompt version defaults to v2 regardless of the passage change', () => {
    expect(resolveSynthesisConfig({}).promptVersion).toBe('v2')
  })
})
