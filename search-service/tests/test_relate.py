from worker.relate import normalize_title, title_similarity, score_pair


def _doc(ext, title_en, lang, detected, msrc=None):
    return {"id": ext, "external_id": ext, "title": title_en, "title_en": title_en,
            "language": lang, "metadata_source": msrc or {}, "detected_language": detected}


def test_normalize_title_strips_punctuation_and_case():
    assert normalize_title("Seizing China's Urban Opportunity!") == normalize_title("seizing chinas urban opportunity")


def test_title_similarity_exact_after_normalization():
    assert title_similarity("Motorcycle Safety: Urban Road Design", "motorcycle safety — urban road design") == 1.0


def test_title_trigger_fires_and_directs_non_english_as_original():
    a = _doc("en_doc", "Rail Plus Property Development in China", "en", "en")
    b = _doc("zh_doc", "Rail Plus Property Development in China", "zh", "zh")
    s = score_pair(a, b, embed_sim=0.66, title_thr=0.75, embed_thr=0.85)
    assert s["trigger"] == "title"
    assert s["direction_proposed"] is True
    assert s["translation_id"] == "en_doc" and s["original_id"] == "zh_doc"


def test_same_detected_language_proposes_no_direction():
    a = _doc("a", "Assessing Low-Carbon Strategies", "zh", "en")
    b = _doc("b", "Assessing Low-Carbon Strategies", "zh", "en")
    s = score_pair(a, b, embed_sim=0.7, title_thr=0.75, embed_thr=0.85)
    assert s["direction_proposed"] is False


def test_embed_trigger_fires_without_title_match():
    a = _doc("a", "Dataset of School Bus Depots", "en", "en")
    b = _doc("b", "Completely Different Name", "en", "en")
    s = score_pair(a, b, embed_sim=0.95, title_thr=0.75, embed_thr=0.85)
    assert s["trigger"] == "embedding"


def test_no_trigger_returns_none():
    a = _doc("a", "Urban Water Report", "en", "en")
    b = _doc("b", "Forest Finance Study", "en", "en")
    assert score_pair(a, b, embed_sim=0.4, title_thr=0.75, embed_thr=0.85) is None


def test_language_disagreement_recorded():
    a = _doc("a", "Seizing China's Urban Opportunity", "zh", "en",
             msrc={"language": "human"})
    b = _doc("b", "Seizing China's Urban Opportunity", "zh", "zh")
    s = score_pair(a, b, embed_sim=0.72, title_thr=0.75, embed_thr=0.85)
    assert s["language_disagreement"] == [{"external_id": "a", "stamped": "zh", "detected": "en"}]
