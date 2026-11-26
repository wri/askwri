"""Pick ordinary content pages across the corpus languages.

The complement of pick_pages.py (which ranks the hardest pages): one or two
unremarkable content pages per document, from documents and pages the 26
November hard set does not already cover, so a candidate's error rate can be
read on pages a rebuild would actually meet.

Seeded: the same seed gives the same list.

Usage: python pick_ordinary_pages.py <pdf_dir> <out.json>
Output: [[doc, page, language, why], ...] for build_set.py's optional selection arg.
"""
import json, pathlib, random, re, subprocess, sys

import pypdfium2 as pdfium
from langdetect import DetectorFactory, detect

DetectorFactory.seed = 0
BAD = re.compile(r"[�\uE000-\uF8FF]")
QUOTA = {"en": 59, "zh": 20, "es": 15, "pt": 4, "id": 2}
MAX_PER_DOC = 2
SEED = 20261126
LANG = {"zh-cn": "zh", "zh-tw": "zh", "es": "es", "pt": "pt", "id": "id", "en": "en"}

pdf_dir, out_path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

# The hard set's (document, page) pairs are excluded, not whole documents: the
# corpus's only Portuguese and Indonesian documents are in the hard set.
here = pathlib.Path(__file__).resolve()
src = (here.parent / "build_set.py").read_text()
hard = {(d, int(p)) for d, p in re.findall(r'\("([0-9]{4}_[^"]+)", (\d+), "\w\w"', src)}


def doc_lang(text):
    # langdetect calls short Chinese pages Korean or Japanese; look at the script first.
    if sum(1 for c in text if "\u4e00" <= c <= "\u9fff") > 0.15 * max(1, len(text)):
        return "zh"
    return LANG.get(detect(text[:600])) if len(text.strip()) >= 200 else None


def page_text(pdf, i):
    return pdf[i].get_textpage().get_text_range()


docs = sorted(p.stem for p in pdf_dir.glob("*.pdf"))
random.Random(SEED).shuffle(docs)

candidates, lang_of = {}, {}
for doc in docs:
    pdf = pdfium.PdfDocument(str(pdf_dir / f"{doc}.pdf"))
    n = len(pdf)
    lang = doc_lang(page_text(pdf, n // 2))
    if lang not in QUOTA:
        continue
    pages = [i + 1 for i in range(2, n - 1)                       # skip cover and TOC
             if len(page_text(pdf, i).strip()) >= 400
             and len(BAD.findall(page_text(pdf, i))) < 5
             and (doc, i + 1) not in hard]
    if pages:
        candidates[doc], lang_of[doc] = pages, lang

taken, selection = {}, []
for rnd in range(MAX_PER_DOC):
    for lang, quota in QUOTA.items():
        for doc in docs:
            if lang_of.get(doc) != lang or taken.get(doc, 0) > rnd:
                continue
            want = min(quota - sum(1 for x in selection if x[2] == lang), MAX_PER_DOC - taken.get(doc, 0))
            if want <= 0:
                break
            picks = random.Random(f"{SEED}-{doc}").sample(candidates[doc], min(want, len(candidates[doc])))
            selection += [[doc, p, lang, "ordinary content page"] for p in picks]
            taken[doc] = taken.get(doc, 0) + len(picks)

selection.sort()
out_path.write_text(json.dumps(selection, indent=1))
counts = {}
for _, _, l, _ in selection:
    counts[l] = counts.get(l, 0) + 1
print(f"{len(selection)} pages from {len({x[0] for x in selection})} documents; {counts}")
