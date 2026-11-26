"""Profile every page of the WRI fixture PDFs for parsing difficulty.
Usage: python profile_pages.py <pdf_dir> <out.jsonl>"""
import json, pathlib, re, sys
import pypdfium2 as pdfium
import pypdfium2.raw as raw
from langdetect import detect, DetectorFactory
DetectorFactory.seed = 0

src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
CJK = re.compile(r"[一-鿿]")
NUM = re.compile(r"(?<![\w.])[-+−]?\d[\d,.]*%?")
TABLE_WORD = re.compile(r"\b(Table|Tabla|Tabela|Tableau)\s*\d|表\s*\d", re.I)
NOTE_WORD = re.compile(r"\b(Notes?|Sources?|Fuentes?|Fonte|Nota)\s*[:：]|来源|注[:：]", re.I)
BAD = re.compile(r"[�-]|\(cid:\d+\)")

def lang_of(text):
    if len(CJK.findall(text)) > 0.2 * max(1, len(re.sub(r"\s", "", text))):
        return "zh"
    try:
        return detect(text) if len(text) > 200 else "?"
    except Exception:
        return "?"

with out.open("w") as f:
    for pdf_path in sorted(src.glob("*.pdf")):
        try:
            pdf = pdfium.PdfDocument(str(pdf_path))
        except Exception as e:
            print("SKIP", pdf_path.name, e, file=sys.stderr); continue
        n = len(pdf)
        texts = []
        for i in range(n):
            page = pdf[i]
            tp = page.get_textpage()
            t = tp.get_text_range()
            w, h = page.get_size()
            img_area = 0.0
            for obj in page.get_objects(max_depth=2):
                if obj.type == raw.FPDF_PAGEOBJ_IMAGE:
                    l, b, r, tt = (obj.get_bounds() if hasattr(obj, "get_bounds") else obj.get_pos())[:4]
                    img_area += max(0, r - l) * max(0, tt - b)
            lines = [l for l in t.splitlines() if l.strip()]
            numeric_lines = sum(len(NUM.findall(l)) >= 3 for l in lines)
            rec = {"doc": pdf_path.stem, "page": i + 1, "pages": n, "chars": len(t.strip()),
                   "nums": len(NUM.findall(t)), "numeric_lines": numeric_lines,
                   "table_word": bool(TABLE_WORD.search(t)), "note_word": bool(NOTE_WORD.search(t)),
                   "bad_chars": len(BAD.findall(t)), "img_cover": round(min(1.0, img_area / (w * h)), 2),
                   "landscape": w > h, "lang": lang_of(t)}
            texts.append(t)
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        doc_lang = lang_of(" ".join(texts[: min(n, 12)]))
        f.write(json.dumps({"doc": pdf_path.stem, "doc_lang": doc_lang, "pages": n}) + "\n")
        print(pdf_path.stem, n, doc_lang, flush=True)
