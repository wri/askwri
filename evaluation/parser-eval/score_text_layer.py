"""Score parser outputs against each page's own PDF text layer.

Born-digital WRI PDFs carry exact characters in their text layer, so it is a
reference for WHAT is on the page (not for reading order or table structure).

Per page and candidate:
  num_recall  share of the text layer's numbers that appear in the output
              (multiset; ',' and '.' treated alike, so 2.9 and 29 stay distinct)
  num_extra   numbers in the output that are not in the text layer: invented
              or misread values, but also legitimate text inside raster images
  text_recall share of the text layer's words (CJK: character pairs) in the output
Pages whose text layer is damaged (replacement / private-use characters) are
flagged, because there the reference itself is wrong.

Usage: python score_text_layer.py <set_dir> [extra_candidate_dir ...]
Candidates: every folder under <set_dir>/openrouter/ plus any extra folders
holding <doc>--p<N>.md files. Needs pypdfium2.
"""
import collections, json, pathlib, re, statistics, sys
import pypdfium2 as pdfium

SET = pathlib.Path(sys.argv[1])
manifest = json.loads((SET / "manifest.json").read_text()) if (SET / "manifest.json").exists() else json.loads((SET / "qa" / "manifest.json").read_text())
cands = {p.name: p for p in sorted((SET / "openrouter").glob("*")) if p.is_dir()}
for extra in sys.argv[2:]:
    cands[pathlib.Path(extra).name] = pathlib.Path(extra)

NUM = re.compile(r"(?<![A-Za-z0-9_.,])[-+−]?\d+(?:[.,]\d+)*")  # ASCII lookbehind: CJK counts as \w
CJK = re.compile(r"[一-鿿]")
WORD = re.compile(r"[^\W\d_]{3,}", re.U)
BAD = re.compile(r"[�-]")


# Same character, different code point: superscript/subscript footnote digits (models
# write ⁵ where the text layer has 5), full-width digits, and Latin ligatures. Full-width
# punctuation is left alone: folding "３，５" to "3,5" would merge two numbers into one.
FOLD = str.maketrans({**{c: str(i) for i, c in enumerate("⁰¹²³⁴⁵⁶⁷⁸⁹")}, **{c: str(i) for i, c in enumerate("₀₁₂₃₄₅₆₇₈₉")},
                      **{chr(0xFF10 + i): str(i) for i in range(10)}, "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl"})


def nums(t):
    return collections.Counter(n.replace("−", "-").replace(",", ".").lstrip("+") for n in NUM.findall(t.translate(FOLD)))


def words(t, zh):
    t = t.translate(FOLD)
    if zh:
        c = CJK.findall(t)
        return collections.Counter(a + b for a, b in zip(c, c[1:]))
    return collections.Counter(w.lower() for w in WORD.findall(t))


def recall(ref, out):
    total = sum(ref.values())
    return None if not total else sum(min(v, out[k]) for k, v in ref.items()) / total


def number_rows(textpage):
    """Visual lines of the page (glyph positions grouped by baseline, read left to
    right) that carry 3+ numbers: in practice, table rows."""
    chars = []
    for i in range(textpage.count_chars()):
        c = textpage.get_text_range(i, 1)
        if not c or c.isspace():
            continue
        l, b, r, t = textpage.get_charbox(i)
        chars.append((c, l, r, (b + t) / 2, max(t - b, 1.0)))
    chars.sort(key=lambda x: -x[3])
    lines, cur = [], []
    for ch in chars:
        if cur and abs(ch[3] - cur[0][3]) > 0.45 * cur[0][4]:
            lines.append(cur); cur = []
        cur.append(ch)
    if cur:
        lines.append(cur)
    out = []
    for line in lines:
        line.sort(key=lambda x: x[1])
        s, prev_r = "", None
        for c, l, r, _, h in line:
            s += (" " if prev_r is not None and l - prev_r > 0.25 * h else "") + c
            prev_r = r
        ns = [n.replace("−", "-").replace(",", ".").lstrip("+") for n in NUM.findall(s.translate(FOLD))]
        if len(ns) >= 3:
            out.append(ns)
    return out


def output_units(text):
    """Markdown lines plus HTML <tr> blocks, each as its ordered list of numbers."""
    units = text.splitlines() + re.findall(r"<tr.*?</tr>", text, re.S | re.I)
    return [[n.replace("−", "-").replace(",", ".").lstrip("+") for n in NUM.findall(u.translate(FOLD))] for u in units]


def in_order(needle, hay):
    it = iter(hay)
    return all(n in it for n in needle)


def row_keep(ref_rows, text):
    """Share of the page's number rows whose numbers appear together, in order, in one output line or row."""
    if not ref_rows:
        return None
    units = output_units(text)
    return sum(any(in_order(r, u) for u in units) for r in ref_rows) / len(ref_rows)


rows = []
for doc in manifest["documents"]:
    zh = doc["actual_language"] == "zh"
    for page in doc["selected_pdf_pages"]:
        ident = f"{doc['id']}--p{page}"
        src = SET / "source-pages" / f"{ident}.pdf"
        if not src.exists():
            src = SET / "qa" / f"{ident}.pdf"
        textpage = pdfium.PdfDocument(str(src))[0].get_textpage()
        ref_text = textpage.get_text_range()
        rn, rw = nums(ref_text), words(ref_text, zh)
        ref_rows = number_rows(textpage)
        damaged = len(BAD.findall(ref_text)) >= 5
        for name, folder in cands.items():
            f = folder / f"{ident}.md"
            text = f.read_text() if f.exists() else ""
            # HTML tables carry numbers in markup (rowspan="2", colspan="8"); keep cell boundaries, drop tags.
            text = re.sub(r"<(td|th)\b[^>]*>", " | ", text, flags=re.I)
            text = re.sub(r"<tr\b[^>]*>", "<tr>", text, flags=re.I)
            text = re.sub(r"<(?!/?tr\b)[^>]+>", " ", text)
            on = nums(text)
            rows.append({"candidate": name, "page": ident, "lang": doc["actual_language"], "damaged_ref": damaged,
                         "missing_output": not text, "ref_numbers": sum(rn.values()),
                         "num_recall": recall(rn, on), "num_extra": sum((on - rn).values()),
                         "ref_number_rows": len(ref_rows), "row_keep": row_keep(ref_rows, text),
                         "text_recall": recall(rw, words(text, zh))})

# A visual line can cross two side-by-side charts or columns, which no correct
# transcription keeps as one row; every model then "loses" it equally. So rows are
# judged relative to the best candidate on the same page: rows_behind_best.
best = collections.defaultdict(float)
for x in rows:
    if x["row_keep"] is not None:
        best[x["page"]] = max(best[x["page"]], x["row_keep"])
for x in rows:
    x["rows_behind_best"] = None if x["row_keep"] is None else round((best[x["page"]] - x["row_keep"]) * x["ref_number_rows"])
# Some text layers carry text nobody can see (e.g. a whole spreadsheet under a
# screenshot of it). When even the best candidate keeps under 80% of the page's
# numbers, the reference is suspect: exclude the page and list it for a look.
best_recall = collections.defaultdict(float)
for x in rows:
    best_recall[x["page"]] = max(best_recall[x["page"]], x["num_recall"] or 0)
for x in rows:
    if x["num_recall"] is not None and best_recall[x["page"]] < 0.8:
        x["damaged_ref"] = "suspect: best candidate recall %.2f" % best_recall[x["page"]]

(SET / "text-layer-scores.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))

def mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else float("nan")

print("candidate\tpages\tmissing\tnum_recall\tnum_extra(total)\trows_behind_best(total)\ttext_recall\tworst pages (num_recall)")
for name in cands:
    r = [x for x in rows if x["candidate"] == name and not x["damaged_ref"]]
    worst = sorted((x for x in r if x["num_recall"] is not None), key=lambda x: x["num_recall"])[:3]
    print(f"{name}\t{len(r)}\t{sum(x['missing_output'] for x in r)}\t{mean(x['num_recall'] for x in r):.3f}\t"
          f"{sum(x['num_extra'] for x in r)}\t{sum(x['rows_behind_best'] or 0 for x in r)}\t{mean(x['text_recall'] for x in r):.3f}\t"
          + ", ".join(f"{x['page'].split('_')[-1]}={x['num_recall']:.2f}" for x in worst))
by_lang = collections.defaultdict(list)
for x in rows:
    if not x["damaged_ref"] and x["num_recall"] is not None:
        by_lang[(x["candidate"], x["lang"])].append(x["num_recall"])
print("\nnum_recall by language")
langs = sorted({l for _, l in by_lang})
print("candidate\t" + "\t".join(langs))
for name in cands:
    print(name + "\t" + "\t".join(f"{mean(by_lang.get((name, l), [])):.3f}" for l in langs))
damaged = sorted({(x["page"], x["damaged_ref"] if isinstance(x["damaged_ref"], str) else "damaged characters") for x in rows if x["damaged_ref"]})
if damaged:
    print("\nexcluded (reference not usable):")
    for page, why in damaged:
        print(" ", page, "-", why)
