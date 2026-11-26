"""Rank pages by parsing difficulty; print top candidates per language.
Usage: python pick_pages.py pages.jsonl"""
import json, sys, collections

recs = [json.loads(l) for l in open(sys.argv[1])]
doc_lang = {r["doc"]: r["doc_lang"] for r in recs if "doc_lang" in r}
pages = [r for r in recs if "page" in r]
FIRST_ROUND = {("2016_towards-a-more-equal-city-framing-the-challenges_8659", 2), ("2016_towards-a-more-equal-city-framing-the-challenges_8659", 3),
               ("2021_zero-emission-logistic-vehicles-promotion_1319", 7), ("2021_zero-emission-logistic-vehicles-promotion_1319", 9),
               ("2023_ciencia-participativa-accion-para-un-aire-limpio_6722", 9), ("2023_ciencia-participativa-accion-para-un-aire-limpio_6722", 11),
               ("2025_trinta-anos-de-expansao-vertical-e-horizontal-em_9049", 8), ("2025_trinta-anos-de-expansao-vertical-e-horizontal-em_9049", 9)}

def score(r):
    s = 0.0
    s += min(r["numeric_lines"], 30) * 1.0          # table-like rows of numbers
    s += min(r["nums"], 200) / 20                    # overall number density
    s += 6 if r["table_word"] else 0
    s += 3 if r["note_word"] else 0
    s += 5 if 0.15 <= r["img_cover"] <= 0.85 else 0  # charts/figures mixed with text
    s += 4 if r["landscape"] else 0
    s += min(r["bad_chars"], 20) / 2                 # damaged text layer
    return s

by_lang = collections.defaultdict(list)
for r in pages:
    lang = doc_lang.get(r["doc"])
    if (r["doc"], r["page"]) in FIRST_ROUND or r["page"] <= 2 or r["page"] >= r["pages"] - 1:
        continue
    scanned = r["chars"] < 40 and r["img_cover"] > 0.8
    if not scanned and (r["chars"] < 600 or r["lang"] != lang):
        continue
    r["score"] = 15.0 if scanned else score(r)
    r["scanned"] = scanned
    by_lang[lang].append(r)

for lang, rows in sorted(by_lang.items()):
    rows.sort(key=lambda r: -r["score"])
    print(f"== {lang}: {len(rows)} eligible pages, scanned={sum(r['scanned'] for r in rows)}")
    per_doc = collections.Counter()
    shown = 0
    for r in rows:
        if per_doc[r["doc"]] >= 2:
            continue
        per_doc[r["doc"]] += 1
        print(f"{r['score']:5.1f} {r['doc']} p{r['page']} chars={r['chars']} numlines={r['numeric_lines']} nums={r['nums']} "
              f"table={int(r['table_word'])} note={int(r['note_word'])} img={r['img_cover']} land={int(r['landscape'])} bad={r['bad_chars']}")
        shown += 1
        if shown >= (14 if lang != "en" else 10):
            break
