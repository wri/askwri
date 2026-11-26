# Parser evaluation tooling

Scripts behind the 26 November 2026 PDF parser comparison (second edition of the
24 November report). Findings and recommendation:
`docs/research/2026-11-26-pdf-parser-openrouter-and-self-hosting.md`. Its §7 is the
same-day follow-up (ordinary pages and the whole hard set) that revised the
recommendation; steps 0, 0b and the optional selection argument to step 3 reproduce it.

Nothing here touches the ingestion worker, QA or production. Outputs go under
`evaluation/results/`, which is gitignored, as the 24 November outputs were.

## Setup

```bash
python3 -m venv /tmp/parser-eval-venv
/tmp/parser-eval-venv/bin/pip install pypdf pypdfium2 langdetect pillow rapidfuzz reportlab
```

Docling, only for `run_docling.py`, in its own environment at the versions the
first edition pinned:

```bash
python3 -m venv /tmp/docling-venv
/tmp/docling-venv/bin/pip install docling==2.152.0 docling-core==2.108.0 docling-ibm-models==4.0.4 docling-parse==7.27.1 torch==2.15.0
```

`run_openrouter.py` needs only the Python standard library.

## OpenRouter key

`run_openrouter.py` reads `OPENROUTER_API_KEY`, else a login-Keychain item
(account `askwri-parser-eval`, service `openrouter-api-key`), else asks with
hidden input and stores the answer there. Store it once with:

```bash
python3 evaluation/parser-eval/run_openrouter.py --set-key
```

The key goes to macOS `security` on standard input, never as a process
argument, and is never written to any output. Never paste it at a shell prompt.

## Workflow

| Step | Script | Does |
|---|---|---|
| 0 | `pick_ordinary_pages.py <pdf_dir> <out.json>` | Seeds one or two unremarkable content pages per document, excluding pages the hard set covers, across the corpus languages |
| 0b | `score_qa_text.py <pdf_dir> <set_dir> [selection.json]` | Scores the Mistral text QA already stores against each page's text layer — no API calls. Read-only; run it through `scripts/with-remote-env.sh qa` with psycopg available |
| 1 | `profile_pages.py <pdf_dir> <pages.jsonl>` | Per page: text-layer size, numbers, numeric rows, table/notes words, image cover, landscape, damaged characters, language |
| 2 | `pick_pages.py <pages.jsonl>` | Ranks the hardest pages per language (max 2 per document) |
| 3 | `build_set.py <pdf_dir> <set_dir> <sheet.png> <first_round_manifest.json> [selection.json]` | Writes a page set: single-page PDFs, text layers, 3x PNG renders for image-only models, manifest, contact sheet. The selection list in the file is the 26 November hard set; a selection JSON replaces it |
| 3b | `build_v2refs.py <recovery-v2> <set_dir>` | Page set of the eight frozen first-edition reference pages, same split PDFs and prompt |
| 4 | `run_openrouter.py --set <set_dir> [model ...]` | Runs models in parallel; `mistral-ocr` is OpenRouter's file-parser engine. Image-only models get `renders/` at the manifest's `render_scale` |
| 4b | `run_docling.py <set_dir>` | Docling, first-edition settings |
| 5 | `score_text_layer.py <set_dir>` | Numbers kept, extra numbers, row keeping and word recall against each page's own text layer; flags pages whose reference is unusable |
| 5b | `score_v2_method.py <recovery-v2> <out.json> name=dir ...` | The first edition's prose and 96-cell scoring, plus HTML-table conversion for candidates that write HTML; re-scores the original candidates as a control. **Needs the gitignored 24 November folder** (`evaluation/results/parser-comparison-2026-11-24/recovery-v2`): it imports the prose scorer from there and reads the frozen references |
| 6 | `list_extra_numbers.py <set_dir> [skip ...]` | Every number a candidate wrote that is not on the page, with context, for review by eye |
| 7 | `build_report_pdf_v3.py <out.pdf>` | The second-edition PDF |
| 8 | `build_report_pdf_v4.py <out.pdf>` | The revised second edition: v3's content plus the §7 follow-on eval as its own section |

## Reading the text-layer scores

These PDFs are born-digital, so each page's text layer records exactly which
characters are printed on it: a reference for content, not for reading order or
table structure. Three things make it lie, all handled or flagged by the scorer:

- **Invisible text.** Some pages carry text nobody can see, such as a whole
  spreadsheet under a screenshot of it. When even the best candidate keeps under
  80% of a page's numbers, the page is excluded and printed with every
  candidate's score. The rule cannot tell invisible text from a page every parser
  genuinely fails, so confirm each one by eye (render the page; compare what is
  visible with `text-layer/<page>.txt`) before trusting the averages. On 26
  November all three such pages were confirmed to carry hidden text.
- **Damaged layers** (replacement or private-use characters): excluded.
- **Same character, different code point**: superscript and full-width digits
  and ligatures are folded; full-width punctuation is not, because folding
  `３，５` to `3,5` would merge two numbers.

"Extra numbers" are leads, not errors: most are HTML attributes, subscripts,
page numbers, scale bars or axis ticks. Check them with `list_extra_numbers.py`.
