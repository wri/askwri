import { EMBEDDERS, MODELS, type ModelId } from '@/config/models'

/** $ per 1M tokens, from the registry. The `openai/` prefix is accepted because
 *  alignment stamps its usage that way; anything else the registry does not
 *  describe THROWS — a silently defaulted rate is how a cost dashboard goes
 *  quietly wrong (design §4). */
export function estimateCostUSD(usage: any): number | null {
  if (!usage) return null
  const raw = String(usage.model ?? '')
  const id = raw.startsWith('openai/') ? raw.slice('openai/'.length) : raw

  const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0)
  const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
  if (!inTok && !outTok) return null

  if (Object.prototype.hasOwnProperty.call(MODELS, id)) {
    const price = MODELS[id as ModelId].price
    if (!price) throw new Error(`no price for ${id}: the registry holds none`)
    return +(
      (inTok / 1_000_000) * price.inputPer1M +
      (outTok / 1_000_000) * price.outputPer1M
    ).toFixed(6)
  }
  if (id === EMBEDDERS.active) {
    return +(
      (inTok / 1_000_000) *
      EMBEDDERS.table[EMBEDDERS.active].inputPer1M
    ).toFixed(6)
  }
  throw new Error(
    `unknown model ${raw || '(none)'}: the registry does not describe it`,
  )
}
