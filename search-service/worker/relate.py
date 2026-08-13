"""Translation-pair suggestion generation (issue #325).

Directed edges: document_id = translation/rendition, related_document_id =
original. This module only INSERTs source='system', status='suggested' rows
and never touches human-reviewed rows (document_tags precedence pattern).
Trigger priority measured on qa 2026-08-13: title similarity is primary
(known pairs' embedding cosines 0.63-0.76 sit BELOW related-but-distinct
docs at 0.85-0.95, so embedding alone cannot distinguish a translation from
a revised edition — it is the secondary, high-bar trigger only).
"""
import logging
import re
from difflib import SequenceMatcher

from psycopg.types.json import Jsonb

from app.config import get_settings

logger = logging.getLogger(__name__)

_NORM_RE = re.compile(r"[^a-z0-9一-鿿]+")
# Apostrophes collapse contractions (China's -> chinas) rather than splitting
# a word into two tokens. Straight ' and curly ’ both occur in WRI titles.
_APOS_RE = re.compile(r"['\u2019]")


def normalize_title(s):
    s = _APOS_RE.sub("", (s or "").lower())
    return " ".join(_NORM_RE.sub(" ", s).split())


def title_similarity(a, b):
    na, nb = normalize_title(a), normalize_title(b)
    if not na or not nb:
        return 0.0
    return SequenceMatcher(None, na, nb).ratio()


def _disagreements(*docs):
    out = []
    for d in docs:
        stamped = d.get("language")
        detected = d.get("detected_language")
        human = (d.get("metadata_source") or {}).get("language") == "human"
        if human and stamped and detected and stamped != detected:
            out.append({"external_id": d["external_id"], "stamped": stamped, "detected": detected})
    return out


def score_pair(doc_a, doc_b, embed_sim, title_thr, embed_thr):
    """Pure scoring: returns the signals dict for a suggestion, or None."""
    t = title_similarity(doc_a.get("title_en") or doc_a.get("title"),
                         doc_b.get("title_en") or doc_b.get("title"))
    e = embed_sim if embed_sim is not None else 0.0
    if t >= title_thr:
        trigger = "title"
    elif e >= embed_thr:
        trigger = "embedding"
    else:
        return None

    la, lb = doc_a.get("detected_language"), doc_b.get("detected_language")
    if la == "en" and lb and lb != "en":
        translation, original, directed = doc_a, doc_b, True
    elif lb == "en" and la and la != "en":
        translation, original, directed = doc_b, doc_a, True
    else:
        translation, original, directed = doc_a, doc_b, False

    return {
        "trigger": trigger,
        "title_similarity": round(t, 4),
        "embedding_similarity": round(e, 4) if embed_sim is not None else None,
        "language_disagreement": _disagreements(doc_a, doc_b),
        "direction_proposed": directed,
        "translation_id": translation["id"],
        "original_id": original["id"],
    }


_ACTIVE_DOCS_SQL = """
    SELECT d.id, d.external_id, d.title, d.title_en, d.language, d.metadata_source
    FROM documents d
    WHERE d.status <> 'withdrawn' AND d.id <> %s
"""

_EMBED_SIM_SQL = """
    SELECT db.id,
           1 - (sa.embedding::vector(1536) <=> sb.embedding::vector(1536)) AS sim
    FROM document_chunks sa
    JOIN documents da ON da.id = sa.document_id
    JOIN document_chunks sb ON sb.unit_type = 'summary'
                           AND sb.embedding_model = sa.embedding_model
    JOIN documents db ON db.id = sb.document_id
    WHERE sa.document_id = %s AND sa.unit_type = 'summary'
      AND db.id <> %s AND db.status <> 'withdrawn'
"""

_PAIR_EXISTS_SQL = """
    SELECT 1 FROM document_relations
    WHERE LEAST(document_id::text, related_document_id::text) = LEAST(%s::text, %s::text)
      AND GREATEST(document_id::text, related_document_id::text) = GREATEST(%s::text, %s::text)
"""


def _detected_language(conn, document_id):
    row = conn.execute(
        "SELECT full_text FROM document_texts WHERE document_id = %s", (document_id,)
    ).fetchone()
    if row is None or not row[0]:
        return None
    from worker.stages.language import detect
    return detect(row[0])


def suggest_for_document(conn, document_id) -> int:
    settings = get_settings()
    me_row = conn.execute(
        """SELECT id, external_id, title, title_en, language, metadata_source
           FROM documents WHERE id = %s""", (document_id,)).fetchone()
    if me_row is None:
        return 0
    cols = ["id", "external_id", "title", "title_en", "language", "metadata_source"]
    me = dict(zip(cols, me_row))
    me["detected_language"] = _detected_language(conn, document_id)

    sims = {r[0]: float(r[1]) for r in conn.execute(_EMBED_SIM_SQL, (document_id, document_id))}
    others = [dict(zip(cols, r)) for r in conn.execute(_ACTIVE_DOCS_SQL, (document_id,))]

    inserted = 0
    for other in others:
        # Cheap pre-screen: only detect the counterpart's text language when a
        # trigger could fire (title close or embedding high).
        t = title_similarity(me.get("title_en") or me.get("title"),
                             other.get("title_en") or other.get("title"))
        e = sims.get(other["id"])
        if t < settings.relation_title_threshold and (e or 0.0) < settings.relation_embed_threshold:
            continue
        if conn.execute(_PAIR_EXISTS_SQL,
                        (me["id"], other["id"], me["id"], other["id"])).fetchone():
            continue
        other["detected_language"] = _detected_language(conn, other["id"])
        signals = score_pair(me, other, e,
                             settings.relation_title_threshold,
                             settings.relation_embed_threshold)
        if signals is None:
            continue
        translation_id = signals.pop("translation_id")
        original_id = signals.pop("original_id")
        confidence = max(signals["title_similarity"], signals["embedding_similarity"] or 0.0)
        conn.execute(
            """INSERT INTO document_relations
               (document_id, related_document_id, source, status, confidence, signals)
               VALUES (%s, %s, 'system', 'suggested', %s, %s)
               ON CONFLICT DO NOTHING""",
            (translation_id, original_id, confidence, Jsonb(signals)))
        inserted += 1
    return inserted
