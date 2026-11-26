"""Second-edition shareable PDF, same layout and styles as the v2 report (recovery-v2/publish_materials.py).
Usage: python build_report_pdf_v3.py <out.pdf>"""
import sys
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="Deck", fontName="Helvetica", fontSize=12, leading=17, textColor=colors.HexColor("#304e5b"), spaceAfter=12))
styles["BodyText"].fontSize = 9; styles["BodyText"].leading = 13; styles["BodyText"].spaceAfter = 8
styles["Heading1"].fontSize = 24; styles["Heading1"].leading = 28; styles["Heading1"].textColor = colors.HexColor("#123b4a")
styles["Heading2"].fontSize = 14; styles["Heading2"].leading = 19
story = []
P = lambda t, style="BodyText": Paragraph(t, styles[style])
def add(t, style="BodyText"): story.append(P(t, style))
def table(rows, widths):
    t = Table([[P(str(v)) for v in row] for row in rows], colWidths=widths, repeatRows=1, hAlign="LEFT")
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e5eef2")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                           ("LINEBELOW", (0, 0), (-1, -1), .4, colors.HexColor("#c4d2da")), ("LEFTPADDING", (0, 0), (-1, -1), 6),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(t); story.append(Spacer(1, 10))

add("AskWRI PDF parser comparison", "Heading1")
add("Second edition | 26 November 2026 (first edition 24 November)", "Deck")
add("Recommendation", "Heading2")
add("Pilot <b>Sonnet 5.5 through WRI's OpenRouter account</b>. On 27 hard pages it kept the same numbers as GPT-6.2 Astra (99.8%, every language) "
    "at about a quarter of Astra's billed cost, and finished fastest. OpenRouter is an organizational route, so the Bedrock permission block no "
    "longer stands in the way. <b>Gemini 3.8 Flash</b> is the budget alternative at about half Sonnet's cost. <b>Mistral OCR</b>, the current parser, "
    "dropped decimal points and chart values: 84% of numbers kept on the hard pages, 73% on Chinese. Replace it.")
add("<b>Pilot, not rollout.</b> References are agent-reviewed, not independent human ground truth, and no retrieval experiment has run. "
    "Pair any model with an automatic check that every number it writes exists in the page's PDF text layer.")
add("Three evaluations", "Heading2")
add("<b>103-page pass</b> (first edition): six whole papers, five variants, every page processed. "
    "<b>Eight reference pages</b>: 20 prose regions (5,600 characters) and 96 table/figure cells, frozen before outputs; now ten variants, "
    "new ones scored with the unchanged v2 scorer, which first reproduced every published number. "
    "<b>27 hard pages</b> (new): the hardest pages per language among 9,292 local pages, Chinese 8, Spanish 7, Portuguese 5, Indonesian 2, English 5, "
    "scored against each page's own text layer.")
add("Eight reference pages", "Heading2")
table([["Variant", "Prose edits / 5,600", "Cells / 96", "Run"],
       ["Mistral OCR (direct)", "2", "54", "103 pages"],
       ["GPT-6.2 Astra (OpenAI, high reasoning)", "0", "96", "103 pages"],
       ["Sonnet 5.5 (Claude Code)", "0", "96", "103 pages"],
       ["Docling base", "544", "60", "103 pages"],
       ["Docling + Astra fallback", "0", "96", "103 pages"],
       ["Sonnet 5.5 (OpenRouter)", "0", "80 *", "8 pages"],
       ["Gemini 3.8 Flash (OpenRouter)", "0", "96", "8 pages"],
       ["Gemini 4 Hydrogen (OpenRouter)", "0", "96", "8 pages"],
       ["Inkling 2 Mini (OpenRouter, 3x image)", "3", "96", "8 pages"]], [190, 100, 70, 90])
add("* All 16 missed cells are one figure: Sonnet wrote the 16 city names as a flat list instead of a four-column table, so group membership is only "
    "implied by position. The same model kept the table through Claude Code. Output format varies between runs; a prompt or validation rule should fix it.")
story.append(PageBreak())

add("27 hard pages", "Heading1")
add("Share of each page's printed numbers kept, 23 scorable pages. Billed by OpenRouter, 26 November.", "Deck")
table([["Variant", "All", "ZH", "ES", "PT", "ID", "EN", "Per 1,000 pages"],
       ["Sonnet 5.5", "99.8%", "100", "100", "100", "97.5", "100", "$23"],
       ["GPT-6.2 Astra (default reasoning)", "99.8%", "100", "100", "100", "97.5", "100", "$89"],
       ["Gemini 4 Hydrogen", "99.8%", "100", "100", "100", "97.5", "100", "$32"],
       ["Inkling 2 Mini (3x image)", "98.5%", "99.9", "96.9", "97.5", "97.5", "100", "$1.37"],
       ["Gemini 3.8 Flash", "98.4%", "97.9", "97.6", "100", "97.5", "100", "$13"],
       ["Mistral OCR (OpenRouter engine)", "83.9%", "73.1", "86.6", "83.0", "97.5", "99.7", "$2.01"],
       ["Docling (local CPU)", "82.1%", "72.9", "89.3", "69.6", "95.9", "99.4", "unpriced"]], [150, 44, 36, 36, 36, 36, 36, 72])
add("Every extra number from Sonnet, Astra and Hydrogen traced to formatting (HTML attributes, subscripts, page numbers, scale bars, axis ticks); none invented a value.")
add("Source-checked defects", "Heading2")
for t in ["Mistral, Chinese freight report p44: decimal points dropped, 4.5-ton trucks became 45-ton and the range 6~7.5 became 6~75. "
          "It also garbles a Spanish materials table and replaces charts with image placeholders.",
          "Inkling 2 Mini, Spanish air-quality report p49: digit errors in a nine-decimal table, 11 of about 585 values (0.61482128 written as 0.61492128). "
          "At 1.5x images it had misread a Chinese rate as 29% instead of 2.9%; 3x images fixed most of that.",
          "Gemini 3.8 Flash, Chinese cities report p26: rebuilt four bar charts as tables with correct values but generic column labels "
          "(indicator value 1/2/3); copies wide visual layouts as one wide table.",
          "Docling: loses chart numbers; reads the text layer, so it picks up invisible text.",
          "First edition, still standing: Mistral changed a median 14% to 16%, a Chinese scenario label, a footnote number, and omitted city groups and "
          "infographic values; Docling interleaves columns and triplicates table columns."]:
    add(t)
add("What the corpus is", "Heading2")
add("Born-digital: 94% of 9,292 local pages carry a real text layer; 341 are image-only, apparently photos and dividers; 20 pages in 7 documents have a damaged layer. "
    "The text layer gives exact characters but no reading order or table structure, and it can hold invisible text: 3 of the 27 hard pages carry hidden "
    "spreadsheet data that every model correctly ignored and a text-layer-only parser, like today's pypdf fallback, would index.")
story.append(PageBreak())

add("Cost, access and limits", "Heading1")
add("One ingestion pass. Billed samples and estimates, not invoices.", "Deck")
table([["Variant", "Per 1,000 pages", "2,000 docs x 20 pages"],
       ["Inkling 2 Mini (billed)", "$1.37", "$55"], ["Mistral OCR via OpenRouter (billed)", "$2.01", "$80"],
       ["Mistral OCR direct (list)", "$4.00", "$160"], ["Gemini 3.8 Flash (billed)", "$13", "$520"],
       ["Sonnet 5.5 via OpenRouter (billed)", "$23", "$920"], ["Gemini 4 Hydrogen (billed)", "$32", "$1,280"],
       ["GPT-6.2 Astra, high reasoning (est.)", "$71.83", "$2,873"], ["GPT-6.2 Astra via OpenRouter (billed)", "$89", "$3,560"]], [200, 110, 140])
add("Billed rates are from the dense hard pages and lean high; on the eight lighter reference pages Sonnet billed $13.93, Gemini 3.8 Flash $7.71 and "
    "Inkling 2 Mini $1.07 per 1,000 pages. Storage, embeddings, retrieval and engineering are excluded.")
add("Tested settings", "Heading2")
add("Second edition: OpenRouter, the first edition's transcription prompt verbatim, single pages, max_tokens 24,000, default model settings. "
    "PDF-native input for Sonnet, Astra and both Geminis; PNG at 3x for Inkling 2 Mini; Mistral via the file-parser engine, transcription taken from "
    "the parser's own annotation. Docling 2.152.0 locally, OCR off, tables on. First-edition settings are unchanged and listed in the v2 report.")
add("Access", "Heading2")
add("OpenRouter calls ran under WRI's account; the key is held in the operator's macOS Keychain and appears in no output. "
    "Bedrock Sonnet remains IAM-denied but is no longer needed. Not tested by choice: Claude Opus 5.5 and Gemini 4 Carbon/Argon (no headroom left to show "
    "at their price), and self-hosted open OCR models (no hosted provider; Fargate workers have no GPUs).")
add("Limits", "Heading2")
add("Agent-reviewed references, not independent human ground truth. Single runs; output format varies between runs. The hard-page scorer measures "
    "numbers and words, not reading order or cell placement. No full-corpus run, no cross-page table continuity and no controlled retrieval "
    "experiment. No QA index, queue, IAM or serving configuration changed.")
add("Evidence: every output, raw response, run record, scorer and the 27 hard source pages are under evidence/v3 on the private report site "
    "(wri-parser-evaluation-lab.bouncychess17.chatgpt.site).")

def footer(c, d):
    c.setFont("Helvetica", 8); c.setFillColor(colors.HexColor("#506975"))
    c.drawString(42, 27, "AskWRI | Parser comparison, second edition | 26 November 2026"); c.drawRightString(570, 27, str(d.page))
SimpleDocTemplate(sys.argv[1], pagesize=(612, 792), rightMargin=64, leftMargin=42, topMargin=40, bottomMargin=42,
                  title="AskWRI parser comparison, second edition").build(story, onFirstPage=footer, onLaterPages=footer)
print("wrote", sys.argv[1])
