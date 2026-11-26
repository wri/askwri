"""Pick ordinary content pages across the corpus languages.

The complement of pick_pages.py (which ranks the hardest pages): one or two
unremarkable content pages per document, from documents and pages the 26
November hard set does not already cover, so a candidate's error rate can be
read on pages a rebuild would actually meet.

Seeded: the same seed gives the same list.

Usage: python pick_ordinary_pages.py <pdf_dir> <out.json>
Output: [[doc, page, language, why], ...] for build_set.py's optional selection arg.
"""
import collections, json, pathlib, random, re, subprocess, sys

import pypdfium2 as pdfium
from langdetect import DetectorFactory, detect

DetectorFactory.seed = 0
BAD = re.compile(r"[�\uE000-\uF8FF]")
QUOTA = {"en": 59, "zh": 20, "es": 15, "pt": 4, "id": 2}
MAX_PER_DOC = 2
SEED = 20261126
LANG = {"zh-cn": "zh", "zh-tw": "zh", "es": "es", "pt": "pt", "id": "id", "en": "en"}

if sys.argv[1:2] == ["--check"]:
    # The committed sample is what the note and the v4 report's B table cite, so
    # check its invariants rather than trusting the generator.
    sel = json.loads((pathlib.Path(__file__).resolve().parent / "ordinary-100-selection.json").read_text())
    pairs = [(d, p) for d, p, _, _ in sel]
    counts = collections.Counter(l for _, _, l, _ in sel)
    assert len(sel) == sum(QUOTA.values()), len(sel)
    assert len(set(pairs)) == len(pairs), "duplicate (document, page)"
    assert dict(counts) == QUOTA, (dict(counts), QUOTA)
    assert len({d for d, _, _, _ in sel}) == 51
    print(f"selection ok: {len(sel)} pages, 51 documents, {dict(counts)}")
    sys.exit(0)

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
            # The second round draws with the same seed, so a document whose only
            # candidate page was taken in the first round would return it again.
            # Keep that page once and top up from pages the document has not given.
            picks = random.Random(f"{SEED}-{doc}").sample(candidates[doc], min(want, len(candidates[doc])))
            picked = {p for d, p, _, _ in selection if d == doc}
            fresh = [p for p in picks if p not in picked]
            rest = [p for p in candidates[doc] if p not in picked and p not in fresh]
            if len(fresh) < want and rest:
                fresh += random.Random(f"{SEED}-{doc}-top-up").sample(rest, min(want - len(fresh), len(rest)))
            if not fresh:
                continue
            selection += [[doc, p, lang, "ordinary content page"] for p in fresh[:want]]
            taken[doc] = taken.get(doc, 0) + len(fresh[:want])

pairs = [(d, p) for d, p, _, _ in selection]
assert len(set(pairs)) == len(pairs), "the selection contains a duplicate (document, page)"
short = sum(QUOTA.values()) - len(selection)
if short:
    print(f"note: {short} pages short of the quotas — no more eligible pages for those languages")

selection.sort()
out_path.write_text(json.dumps(selection, indent=1))
counts = {}
for _, _, l, _ in selection:
    counts[l] = counts.get(l, 0) + 1
print(f"{len(selection)} pages from {len({x[0] for x in selection})} documents; {counts}")
