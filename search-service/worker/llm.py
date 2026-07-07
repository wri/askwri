"""Shared LLM access for worker stages. JSON-schema structured output."""
import json
import logging
import os

logger = logging.getLogger(__name__)

# Max attempts for a single chat_json call: structured output can intermittently
# return content=None (truncated, finish_reason='length') or a non-JSON string;
# a single retry recovers the vast majority. Raises a clear error if it persists.
_MAX_ATTEMPTS = 2


def chat_json(system: str, user: str, schema: dict, model: str, max_tokens: int = 1500) -> dict:
    """One chat call with json_schema structured output; retries once on a
    None/truncated/unparseable response. Raises RuntimeError naming the
    finish_reason if the response is still unusable after the retry."""
    from openai import OpenAI

    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    last_reason = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        # On a retry following a truncation (finish_reason='length'), give the
        # model more room so the structured output isn't cut off mid-JSON.
        budget = max_tokens * attempt
        resp = client.chat.completions.create(
            model=model,
            max_completion_tokens=budget,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            response_format={"type": "json_schema",
                             "json_schema": {"name": "result", "strict": True, "schema": schema}},
        )
        choice = resp.choices[0]
        content = choice.message.content
        last_reason = choice.finish_reason
        if content:
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                logger.warning("chat_json attempt %d: unparseable JSON (finish_reason=%s)", attempt, last_reason)
        else:
            logger.warning("chat_json attempt %d: empty content (finish_reason=%s)", attempt, last_reason)
    raise RuntimeError(
        f"chat_json: model returned empty or truncated JSON after {_MAX_ATTEMPTS} attempts "
        f"(finish_reason={last_reason}); raise max_tokens or shorten the input"
    )
