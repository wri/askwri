"""Build the hard page set: single-page PDFs, text-layer reference, manifest, contact sheet.
Usage: python build_set.py <pdf_dir> <set_dir> <contact_sheet.png> <first_round_manifest.json>"""
import hashlib, json, pathlib, sys
import pypdf, pypdfium2 as pdfium
from PIL import Image, ImageDraw

src, out, sheet_path, first = (pathlib.Path(a) for a in sys.argv[1:5])
SELECTION = [  # (doc, page, language, why)
    ("2025_from-concept-to-application-analyzing-just_6237", 79, "zh", "dense numeric table"),
    ("2020_quantifying-the-grid-impacts-from-large-adoption_6748", 37, "zh", "numeric rows, notes"),
    ("2024_accelerating-zero-emission-truck-adoption-in_6287", 55, "zh", "table with notes"),
    ("2024_feasibility-of-zero-emission-freight-zones_1267", 44, "zh", "table with notes"),
    ("2024_optimizing-container-ports-transportation-and_9894", 30, "zh", "table with notes"),
    ("2022_research-on-medium-and-long-term-in-depth_4687", 38, "zh", "table with notes"),
    ("2024_a-comparative-study-of-low-carbon-development_7471", 26, "zh", "number-dense prose"),
    ("2019_toward-net-zero-emissions-in-the-road-transport_1735", 16, "zh", "table with notes"),
    ("2020_indice-de-desigualdad-urbana_3387", 48, "es", "dense numeric table"),
    ("2025_aire-limpio-en-barrios-vitales_9425", 49, "es", "very dense numbers, notes"),
    ("2021_mexican-cities-expansion-trends-and-their-impacts_9595", 63, "es", "numeric rows, notes"),
    ("2021_el-costo-de-la-expansion-urbana-en-mexico_9471", 84, "es", "numbers, notes"),
    ("2022_guia-de-entornos-caminables-seguros_2940", 175, "es", "landscape, table + figure"),
    ("2023_base-de-datos-ajustada-de-la-encuesta-origen_2276", 12, "es", "table with notes"),
    ("2023_analisis-de-los-mecanismos-financieros-para-la_3765", 8, "es", "table in prose"),
    ("2024_manual-da-pesquisa-de-satisfacao-qualionibus_7600", 45, "pt", "landscape, very dense table"),
    ("2021_ruas-completas-no-brasil-promovendo-uma-mudanca_5028", 43, "pt", "damaged text layer, figure"),
    ("2021_ruas-completas-no-brasil-promovendo-uma-mudanca_5028", 48, "pt", "table with notes"),
    ("2025_trinta-anos-de-expansao-vertical-e-horizontal-em_9049", 11, "pt", "chart/map with notes"),
    ("2025_trinta-anos-de-expansao-vertical-e-horizontal-em_9049", 13, "pt", "chart/map with notes"),
    ("2025_panduan-pelaksanaan-inventarisasi-pohon-perkotaan_4324", 36, "id", "landscape table"),
    ("2025_panduan-pelaksanaan-inventarisasi-pohon-perkotaan_4324", 47, "id", "landscape table"),
    ("2019_climate-emergency-urban-opportunity_4461", 33, "en", "dense table, notes"),
    ("2024_dataset-of-us-school-bus-depots_6105", 18, "en", "dense numeric table"),
    ("2019_untreated-and-unsafe-solving-the-urban-sanitation_4318", 21, "en", "table, notes"),
    ("2020_impactar-tool-valuing-air-quality-health-impacts_1028", 31, "en", "very long, small print"),
    ("2023_assessing-the-environmental-impact-of-shared_4976", 49, "en", "table, notes"),
]

prompt = json.loads(first.read_text())["prompt"]
(out / "source-pages").mkdir(parents=True, exist_ok=True)
(out / "text-layer").mkdir(exist_ok=True)
(out / "renders").mkdir(exist_ok=True)
RENDER_SCALE = 3  # image-only models; at 1.5x Inkling 2 Mini misread digits
docs, thumbs = {}, []
for doc, page, lang, why in SELECTION:
    ident = f"{doc}--p{page}"
    w = pypdf.PdfWriter()
    w.add_page(pypdf.PdfReader(src / f"{doc}.pdf").pages[page - 1])
    with open(out / "source-pages" / f"{ident}.pdf", "wb") as f:
        w.write(f)
    pdf = pdfium.PdfDocument(str(out / "source-pages" / f"{ident}.pdf"))
    (out / "text-layer" / f"{ident}.txt").write_text(pdf[0].get_textpage().get_text_range())
    pdf[0].render(scale=RENDER_SCALE).to_pil().save(out / "renders" / f"{ident}.png")
    img = pdf[0].render(scale=0.35).to_pil()
    img.thumbnail((260, 260))
    thumbs.append((img, f"{lang} {doc.split('_')[-1]} p{page}"))
    d = docs.setdefault(doc, {"id": doc, "actual_language": lang, "declared_language": lang, "selected_pdf_pages": [], "why": {}})
    d["selected_pdf_pages"].append(page)
    d["why"][str(page)] = why
    print(ident, hashlib.sha256((out / "source-pages" / f"{ident}.pdf").read_bytes()).hexdigest()[:12])

manifest = {"prompt": prompt, "source": str(src), "render_scale": f"{RENDER_SCALE}x", "selection": "hardest pages per language by table/number/notes/figure/landscape/damaged-text heuristics; max 2 per document; first-round pages excluded",
            "models": ["google/gemini-3.8-flash", "google/gemini-4-hydrogen", "anthropic/claude-sonnet-5.5", "openai/gpt-6.2-astra"],
            "documents": list(docs.values())}
(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))

cols = 7
rows = (len(thumbs) + cols - 1) // cols
sheet = Image.new("RGB", (cols * 270, rows * 290), "white")
dr = ImageDraw.Draw(sheet)
for i, (img, label) in enumerate(thumbs):
    x, y = (i % cols) * 270 + 5, (i // cols) * 290 + 5
    sheet.paste(img, (x, y))
    dr.text((x, y + 265), label, fill="black")
sheet.save(sheet_path)
