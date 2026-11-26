"""Docling on a page set, same settings as the 24 November round:
CPU, 4 threads, OCR off (born-digital text layers), table structure on, no picture
descriptions or chart extraction. Outputs: <set>/openrouter/docling/<page>.md so the
scorer picks it up beside the API candidates (folder name only; nothing is sent).
Needs the pinned Docling stack (README). Usage: python run_docling.py <set_dir>"""
import importlib.metadata, json, pathlib, sys, time
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions, AcceleratorOptions, AcceleratorDevice

ROOT = pathlib.Path(sys.argv[1]).resolve()
OUT = ROOT / "openrouter" / "docling"
OUT.mkdir(parents=True, exist_ok=True)
options = PdfPipelineOptions(do_ocr=False, do_table_structure=True, do_picture_description=False, do_chart_extraction=False, document_timeout=180)
options.accelerator_options = AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=4)
converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
results = []
for path in sorted((ROOT / "source-pages").glob("*.pdf")):
    t = time.monotonic()
    row = {"file": path.name, "candidate": "docling", "version": importlib.metadata.version("docling"),
           "settings": {"do_ocr": False, "do_table_structure": True, "do_picture_description": False, "do_chart_extraction": False, "device": "cpu", "threads": 4}}
    try:
        result = converter.convert(path)
        text = result.document.export_to_markdown()
        (OUT / (path.stem + ".md")).write_text(text)
        row.update(status=str(result.status), chars=len(text), tables=len(result.document.tables))
    except Exception as e:
        row.update(status="error", error=type(e).__name__ + ": " + str(e)[:1500])
    row["wall_seconds"] = round(time.monotonic() - t, 3)
    results.append(row)
    (OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(path.stem, row["status"], row.get("chars"), row.get("error", ""), flush=True)
