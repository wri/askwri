"""Score candidates on the 8 frozen v2 reference pages with the v2 method, unchanged.

Prose: analyze.prose_score (best local span, Levenshtein edits / reference chars).
Cells: the audited table recovery of recovery-v2/audit_tables.py (same format
handling: collapsed repeated columns, dropped empty layout column, card pairs).
The frozen reference hash is checked first. v2's own candidates are re-scored as
a control: they must reproduce the published numbers before new ones are trusted.

Usage: python score_v2_method.py <recovery-v2 dir> <out.json> <name=dir> [<name=dir> ...]
recovery-v2 is the 24 November results folder (evaluation/results/parser-comparison-2026-11-24/recovery-v2).
"""
import hashlib, json, pathlib, re, sys

V2 = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])
sys.path.insert(0, str(V2))
from analyze import norm, prose_score  # noqa: E402
from rapidfuzz import fuzz  # noqa: E402

ref_bytes = (V2 / "references/reference-v2.json").read_bytes()
assert hashlib.sha256(ref_bytes).hexdigest() == (V2 / "references/FROZEN.sha256").read_text().split()[0], "reference changed"
refs = json.loads(ref_bytes)


def canonical(s):
    return re.sub(r"[;:,()\[\]]", "", norm(s))


def tables(text):  # audit_tables.tables
    groups, rows = [], []
    for line in text.splitlines() + [""]:
        if line.strip().startswith("|") or line.count("|") >= 3:
            cells = [x.strip() for x in line.strip().strip("|").split("|")]
            if len(cells) > 1 and not all(re.fullmatch(r"[:\-\s]*", c) for c in cells):
                rows.append(cells)
        elif line.strip() and rows:
            groups.append(rows); rows = []
    if rows:
        groups.append(rows)
    return groups


def headscore(h, c):
    a, b = canonical(h), canonical(c)
    return 100 if a and a in b else fuzz.ratio(a, b)


def html_tables_to_pipes(text):
    """v2 candidates wrote Markdown; some new ones write HTML tables. Convert <tr>/<td>
    rows to pipe rows so the unchanged v2 cell audit can read them (colspan/rowspan
    are not expanded, which can only lower a candidate's score)."""
    def row(m):
        cells = re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", m.group(0), re.S | re.I)
        return "\n| " + " | ".join(re.sub(r"<[^>]+>", " ", c).strip() for c in cells) + " |\n"
    return re.sub(r"<tr\b.*?</tr>", row, text, flags=re.S | re.I)


def audit(text, ref):  # audit_tables.py loop body, per table
    options = []
    for original in tables(text):
        t = [list(x) for x in original]; note = []
        if len(t[0]) > len(ref["headers"]):
            keep = [0] + [i for i in range(1, len(t[0])) if t[0][i] != t[0][i - 1]]
            if len(keep) == len(ref["headers"]) and all(all(row[i] == row[i - 1] for i in range(1, len(t[0])) if i not in keep) for row in t[:6] if len(row) == len(t[0])):
                t = [[row[i] for i in keep] for row in t if len(row) == len(original[0])]; note.append("collapsed repeated columns")
        if len(t[0]) == len(ref["headers"]) + 1 and t[0][1] == "":
            t = [a[:1] + a[2:] for a in t if len(a) == len(original[0])]; note.append("dropped empty layout column")
        if len(t[0]) != len(ref["headers"]):
            continue
        score = sum(max(headscore(h, c) for c in t[0]) for h in ref["headers"]) / len(ref["headers"])
        options.append((score, t, note))
    score, t, note = max(options, default=(0, [], []), key=lambda x: x[0]); t = t if score >= 50 else []
    cells = []
    for ri, row in enumerate(ref["rows"]):
        a = None
        if t:
            if ref["id"] == "figure11-city-groups":
                a = t[ri + 1] if ri + 1 < len(t) else None
            else:
                opts = [(fuzz.ratio(canonical(row[0]), canonical(x[0])), x) for x in t[1:] if len(x) == len(ref["headers"])]
                best = max(opts, default=(0, None), key=lambda x: x[0]); a = best[1] if best[0] >= 50 else None
        for ci, value in enumerate(row):
            actual = a[ci] if a is not None and ci < len(a) else None
            if ref["id"] == "statistics-cards" and actual is None:
                n = canonical(text); label, val = canonical(row[0]), canonical(row[1])
                if label + val in n or val + label in n:
                    actual = value
                else:
                    for cards in tables(text):
                        if len(cards) >= 2 and len(cards[0]) == 5 and len(cards[1]) == 5:
                            for c in range(5):
                                if {canonical(cards[0][c]), canonical(cards[1][c])} == {label, val}:
                                    actual = value
            cells.append({"row": row[0], "column": ref["headers"][ci], "expected": value, "candidate": actual,
                          "match": actual is not None and canonical(value) == canonical(actual)})
    return {"table_id": ref["id"], "notes": note, "matched": sum(c["match"] for c in cells), "total": len(cells), "cells": cells}


results = {}
for arg in sys.argv[3:]:
    name, folder = arg.split("=", 1)
    folder = pathlib.Path(folder)
    per_page = []
    for page in refs["pages"]:
        f = folder / f"{page['id']}.md"
        text = html_tables_to_pipes(f.read_text()) if f.exists() else ""
        prose = [prose_score(b["text"], text) for b in page["prose_blocks"]]
        tabs = [audit(text, t) for t in page["tables"]]
        per_page.append({"page": page["id"], "language": page["language"], "missing": not text,
                         "prose_errors": sum(p["errors"] for p in prose), "prose_chars": sum(p["reference_chars"] for p in prose),
                         "cells_matched": sum(t["matched"] for t in tabs), "cells_total": sum(t["total"] for t in tabs), "tables": tabs})
    results[name] = per_page

OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2))
langs = ["en", "zh", "es", "pt"]
print("candidate\tprose edits/chars\tcells\t" + "\t".join(langs))
for name, pages in results.items():
    by = {l: [p for p in pages if p["language"] == l] for l in langs}
    cols = [f"{sum(p['prose_errors'] for p in v)}/{sum(p['prose_chars'] for p in v)} {sum(p['cells_matched'] for p in v)}/{sum(p['cells_total'] for p in v)}" for v in by.values()]
    print(f"{name}\t{sum(p['prose_errors'] for p in pages)}/{sum(p['prose_chars'] for p in pages)}\t"
          f"{sum(p['cells_matched'] for p in pages)}/{sum(p['cells_total'] for p in pages)}\t" + "\t".join(cols)
          + ("\tMISSING " + str(sum(p['missing'] for p in pages)) if any(p["missing"] for p in pages) else ""))
