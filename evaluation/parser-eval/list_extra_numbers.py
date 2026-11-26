"""List, per candidate and page, numbers in the output that are not in the text layer, with context."""
import collections, json, pathlib, re, sys
import pypdfium2 as pdfium

SET = pathlib.Path(sys.argv[1])
NUM = re.compile(r"(?<![A-Za-z0-9_.,])[-+−]?\d+(?:[.,]\d+)*")
FOLD = str.maketrans({**{c: str(i) for i, c in enumerate("⁰¹²³⁴⁵⁶⁷⁸⁹")}, **{c: str(i) for i, c in enumerate("₀₁₂₃₄₅₆₇₈₉")},
                      **{chr(0xFF10 + i): str(i) for i in range(10)}})
norm = lambda n: n.replace("−", "-").replace(",", ".").lstrip("+")
skip = set(sys.argv[2:])
manifest = json.loads((SET / "manifest.json").read_text())
for doc in manifest["documents"]:
    for page in doc["selected_pdf_pages"]:
        ident = f"{doc['id']}--p{page}"
        if any(s in ident for s in skip):
            continue
        ref = collections.Counter(norm(n) for n in NUM.findall(pdfium.PdfDocument(str(SET / "source-pages" / f"{ident}.pdf"))[0].get_textpage().get_text_range().translate(FOLD)))
        for cand in sorted((SET / "openrouter").glob("*")):
            text = (cand / f"{ident}.md").read_text().translate(FOLD)
            found = [(m.group(), m.start()) for m in NUM.finditer(text)]
            out = collections.Counter(norm(n) for n, _ in found)
            extra = out - ref
            if not extra:
                continue
            shown, ctx = collections.Counter(), []
            for n, pos in found:
                k = norm(n)
                if extra[k] > shown[k]:
                    shown[k] += 1
                    ctx.append(text[max(0, pos - 25):pos + len(n) + 10].replace("\n", " "))
            print(f"\n## {ident.split('_')[-1]} {cand.name} extra={sum(extra.values())}")
            for c in ctx[:12]:
                print("   ", c)
