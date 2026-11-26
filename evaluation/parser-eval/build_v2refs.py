"""Page set = the 8 frozen v2 reference pages, same split PDFs and prompt as the 24 Nov v2 run.
Usage: python build_v2refs.py <recovery-v2 dir> <out set dir>"""
import json, pathlib, shutil, sys
import pypdfium2 as pdfium

v2, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
refs = json.loads((v2 / "references/reference-v2.json").read_text())
prompt = json.loads((v2 / "run-settings.json").read_text())["openai"]["prompt"]
(out / "source-pages").mkdir(parents=True, exist_ok=True)
(out / "renders").mkdir(exist_ok=True)
docs = {}
for p in refs["pages"]:
    ident = p["id"]
    doc, page = ident.rsplit("--p", 1)
    shutil.copy2(v2 / "source-pages" / f"{ident}.pdf", out / "source-pages" / f"{ident}.pdf")
    pdfium.PdfDocument(str(out / "source-pages" / f"{ident}.pdf"))[0].render(scale=3).to_pil().save(out / "renders" / f"{ident}.png")
    d = docs.setdefault(doc, {"id": doc, "actual_language": p["language"], "declared_language": p["language"], "selected_pdf_pages": []})
    d["selected_pdf_pages"].append(int(page))
manifest = {"prompt": prompt, "render_scale": "3x",
            "source": "recovery-v2/source-pages (exact split PDFs of the 24 Nov v2 run); pages = references/reference-v2.json",
            "models": ["anthropic/claude-sonnet-5.5", "google/gemini-3.8-flash", "google/gemini-4-hydrogen", "thinkingmachines/inkling-2-mini"],
            "documents": list(docs.values())}
(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
print(len(refs["pages"]), "pages;", [d["actual_language"] for d in docs.values()])
