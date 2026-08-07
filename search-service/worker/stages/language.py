"""Stage: detect document language; record on documents.

LANGUAGE_MAP extends Phase 0's with Indonesian ('id') — the 2 'Bahasa' docs
mislabeled as 'en' get corrected on re-ingest. zh text is NOT mutated here;
Traditional->Simplified normalization happens at chunk time (embed stage) so
document_texts keeps the original for display (capture-rich principle).
"""
import logging

from app.db import get_pool
from worker.stages import fetch_document, stage

logger = logging.getLogger(__name__)

SUPPORTED = {"en", "es", "zh", "pt", "id"}


def detect(text: str) -> str:
    """Detect the document's primary language.

    Long docs vote across head/middle/late windows: WRI zh/es/pt reports
    carry English cover/title/abstract front matter, so a head-only sample
    detects 'en' and a re-ingest would corrupt documents.language (found
    2026-07-22: 4 of 9 non-EN fixture docs flipped, under both parsers).
    The native body outvotes the cover; en wins a tie only if no supported
    non-en code is tied (the cover is what injects 'en').
    """
    from collections import Counter

    from langdetect import DetectorFactory, detect as _detect

    DetectorFactory.seed = 0  # deterministic

    def _one(sample: str) -> str | None:
        try:
            code = _detect(sample)
        except Exception:
            return None
        return "zh" if code.startswith("zh") else code

    n = len(text)
    if n <= 15000:
        windows = [text[:5000]]
    else:
        mid, late = n // 2, (4 * n) // 5
        windows = [text[:5000], text[mid:mid + 5000], text[late:late + 5000]]

    # Character evidence beats langdetect for CJK: zh papers with English
    # covers AND English reference/table sections lose the window vote
    # [en, zh, en] because langdetect calls 35%-CJK mixed windows 'en'
    # (2026-07-22: docs flipped zh->en on re-ingest). A substantial CJK
    # fraction across the samples is unambiguous — no genuinely-English
    # doc is 15% CJK characters.
    sample = "".join(windows)
    if sample:
        cjk = sum(1 for c in sample if "一" <= c <= "鿿")
        if cjk / len(sample) >= 0.15:
            return "zh"

    votes = [c for c in (_one(w) for w in windows) if c]
    if not votes:
        return "en"
    counts = Counter(votes)
    top = max(counts.values())
    tied = [c for c, k in counts.items() if k == top]
    winner = tied[0]
    if len(tied) > 1:
        non_en = [c for c in tied if c != "en" and c in SUPPORTED]
        if non_en:
            winner = non_en[0]
    return winner if winner in SUPPORTED else "en"


@stage("language")
def run(document_id):
    with get_pool().connection() as conn:
        doc = fetch_document(conn, document_id)
        row = conn.execute(
            "SELECT full_text FROM document_texts WHERE document_id = %s", (document_id,)
        ).fetchone()
        lang = detect(row[0])
        # Merge the newly-detected language into the existing set; never shrink
        # the array. Design §7.4 ("detect the set present") + §323 ("preserve
        # existing languages"): a re-ingest must not drop a language a doc had.
        # Order: detected primary first, then any pre-existing codes preserved.
        existing = doc["languages"] or []
        merged = list(dict.fromkeys([lang, *existing]))  # dedupe, preserve order
        conn.execute(
            "UPDATE documents SET language=%s, languages=%s, updated_at=now() WHERE id=%s",
            (lang, merged, document_id),
        )
        logger.info(f"doc {document_id}: language={lang}, languages={merged}")
    return None
