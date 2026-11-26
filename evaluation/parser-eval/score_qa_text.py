"""Score the Mistral text already stored in QA against each page's text layer.

The parse-quality runs parse candidates afresh; the current parser's output is
already in document_texts, so its error rate needs no API calls. This builds a
page set (single-page PDFs, one .md per page from QA's stored text split by
page_boundaries) and runs score_text_layer.py with qa-mistral as an extra
candidate.

Read-only. Needs DATABASE_URL (run it through scripts/with-remote-env.sh qa),
psycopg, pypdf and pypdfium2.

Usage: python score_qa_text.py <pdf_dir> <set_dir> [selection.json]
Without selection.json, every page of the documents in build_set.py's hard set.
"""
import json, os, pathlib, re, subprocess, sys

import psycopg
from pypdf import PdfReader, PdfWriter

HERE = pathlib.Path(__file__).resolve()
pdf_dir, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

# (doc, language) pairs and, when a selection is given, which pages of each.
src = (HERE.parent / "build_set.py").read_text()
lang = {d: l for d, l in re.findall(r'\("([0-9]{4}_[^"]+)", \d+, "(\w\w)"', src)}
if len(sys.argv) > 3:
    sel = json.loads(pathlib.Path(sys.argv[3]).read_text())
    wanted = {}
    for doc, page, language, *_ in sel:
        wanted.setdefault(doc, set()).add(int(page))
        lang[doc] = language
else:
    wanted = {d: None for d in lang}      # None: every page with text

(out / "source-pages").mkdir(parents=True, exist_ok=True)
(out / "qa-mistral").mkdir(exist_ok=True)
manifest = {"prompt": "unused (scoring only)", "source": str(pdf_dir), "documents": []}

with psycopg.connect(os.environ["DATABASE_URL"], sslmode="require", connect_timeout=20) as conn:
    for doc in sorted(wanted):
        row = conn.execute("""select t.full_text, t.page_boundaries
                              from document_texts t join documents d on d.id = t.document_id
                              where d.external_id = %s""", (doc,)).fetchone()
        if not row:
            print(f"{doc}: no QA text, skipped")
            continue
        full, bounds = row
        pdf = PdfReader(str(pdf_dir / f"{doc}.pdf"))
        pages, cursor = [], 0
        for b in bounds:
            n, end = int(b["page"]), int(b["end_pos"])
            text, cursor = full[cursor:end].strip(), end
            if not text or n > len(pdf.pages) or (wanted[doc] and n not in wanted[doc]):
                continue
            ident = f"{doc}--p{n}"
            w = PdfWriter()
            w.add_page(pdf.pages[n - 1])
            with open(out / "source-pages" / f"{ident}.pdf", "wb") as f:
                w.write(f)
            (out / "qa-mistral" / f"{ident}.md").write_text(text)
            pages.append(n)
        manifest["documents"].append({"id": doc, "actual_language": lang[doc],
                                      "declared_language": lang[doc], "selected_pdf_pages": pages})

(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
print(f"pages built: {sum(len(d['selected_pdf_pages']) for d in manifest['documents'])}")
subprocess.run([sys.executable, str(HERE.parent / "score_text_layer.py"), str(out), str(out / "qa-mistral")], check=True)
