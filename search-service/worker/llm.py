"""Shared LLM access for worker stages. JSON-schema structured output."""
import json
import logging
import os

logger = logging.getLogger(__name__)


def chat_json(system: str, user: str, schema: dict, model: str, max_tokens: int = 1500) -> dict:
    """One chat call with json_schema structured output; raises on failure."""
    from openai import OpenAI

    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    resp = client.chat.completions.create(
        model=model,
        max_completion_tokens=max_tokens,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={"type": "json_schema",
                         "json_schema": {"name": "result", "strict": True, "schema": schema}},
    )
    return json.loads(resp.choices[0].message.content)
