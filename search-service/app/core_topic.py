"""Conservative normalization for the corpus-coverage check (#402).

This does not make LLM extraction deterministic. It collapses equivalent
subject/purpose and generic-location forms before caching and matching, so
their incidental framing cannot count as evidence that a subject is covered.
Named geography and noun phrases such as 'Coalition for Urban Transitions'
are retained. No query-specific vocabulary or arbitrary length cap.
"""
import re


def normalize_core_topic(topic: str) -> str:
    topic = " ".join(topic.split())
    # 'using X to ...' identifies X as the subject and the infinitive as its
    # purpose. Do not cut arbitrary 'to' phrases (e.g. 'access to transport').
    if re.match(r"^using\s+", topic, flags=re.IGNORECASE):
        topic = re.sub(r"^using\s+", "", topic, flags=re.IGNORECASE)
        topic = re.split(
            r"\s+to\s+(?:increase|decrease|reduce|improve|enhance|support|"
            r"promote|address|mitigate|achieve|enable|prevent)\b",
            topic, maxsplit=1, flags=re.IGNORECASE,
        )[0]
    # Generic urban setting is framing in a corpus about cities. Keep named
    # places and modifiers ('in China', 'in Chinese cities', 'in coastal cities').
    topic = re.sub(
        r"\s+in\s+(?:cities|urban areas|urban settings)\s*[.!?]?$",
        "", topic, flags=re.IGNORECASE,
    )
    return topic.strip()


def core_topic_candidates(topic: str) -> list[str]:
    """Full normalized phrase, then contiguous bigrams; never loose words."""
    topic = normalize_core_topic(topic)
    if not topic:
        return []
    words = topic.split()
    return list(dict.fromkeys([
        topic, *(" ".join(words[i:i + 2]) for i in range(len(words) - 1)),
    ]))
