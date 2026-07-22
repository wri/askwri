"""Phase 0 parse-quality fixture runner (bake-off plan 2026-07-02 §5.3,
shortlist updated 2026-07-22).

For each doc in evaluation/fixtures/parse-bakeoff-manifest.json, parse the
PDF with the selected backend and write
evaluation/results/parse-fixture-<backend>.json:
  {parser, results: [{external_id, language, category, pages_expected,
                      chars, wall_ms, full_text, markdown?, error?}]}

Backends:
  pypdf    — the production worker parse path (baseline / validation oracle)
  bda      — Bedrock Data Automation (needs PARSE_BAKEOFF_BUCKET env, an
             existing BDA project ARN in PARSE_BAKEOFF_BDA_PROJECT, and AWS
             creds; async S3-in/S3-out)
  gemini   — Gemini vision parse to markdown (needs GEMINI_API_KEY;
             GEMINI_PARSE_MODEL overrides the default model id)
  mistral  — Mistral OCR API (needs MISTRAL_API_KEY)

Run: cd search-service && ./venv/bin/python -m scripts.parse_fixture <backend>
Score afterwards with scripts/score_parse_fixture.py.
"""
import base64
import json
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPO_ROOT / "evaluation" / "fixtures" / "parse-bakeoff-manifest.json"
OUT_DIR = REPO_ROOT / "evaluation" / "results"


# --- backends ---------------------------------------------------------------

def parse_pypdf(pdf_bytes: bytes, doc: dict) -> dict:
    from worker.stages.parse import _parse_pdf

    full_text, boundaries = _parse_pdf(pdf_bytes)
    return {"full_text": full_text, "pages_parsed": len(boundaries)}


def parse_mistral(pdf_bytes: bytes, doc: dict) -> dict:
    import requests

    api_key = os.environ.get("MISTRAL_API_KEY")
    if not api_key:
        raise RuntimeError("MISTRAL_API_KEY not set")
    data_uri = ("data:application/pdf;base64,"
                + base64.b64encode(pdf_bytes).decode())
    r = requests.post(
        "https://api.mistral.ai/v1/ocr",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"model": os.environ.get("MISTRAL_OCR_MODEL", "mistral-ocr-latest"),
              "document": {"type": "document_url", "document_url": data_uri}},
        timeout=900,
    )
    r.raise_for_status()
    pages = r.json().get("pages", [])
    markdown = "\n\n".join(p.get("markdown", "") for p in pages)
    return {"full_text": markdown, "markdown": markdown,
            "pages_parsed": len(pages)}


def parse_gemini(pdf_bytes: bytes, doc: dict) -> dict:
    from google import genai

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")
    client = genai.Client(api_key=api_key)
    model = os.environ.get("GEMINI_PARSE_MODEL", "gemini-3-flash")
    prompt = (
        "Convert this PDF to clean GitHub-flavored markdown. Preserve the "
        "document's reading order, headings (as #/##/###), tables (as "
        "markdown tables), and figure captions. Reproduce the text exactly — "
        "do not summarize, translate, or omit content. Keep numbers "
        "verbatim. Separate each page with a line containing only "
        "'<!-- page: N -->'."
    )
    resp = client.models.generate_content(
        model=model,
        contents=[genai.types.Part.from_bytes(data=pdf_bytes,
                                              mime_type="application/pdf"),
                  prompt],
    )
    markdown = resp.text or ""
    pages_parsed = markdown.count("<!-- page:")
    return {"full_text": markdown, "markdown": markdown,
            "pages_parsed": pages_parsed}


def parse_bda(pdf_bytes: bytes, doc: dict) -> dict:
    import boto3

    bucket = os.environ.get("PARSE_BAKEOFF_BUCKET")
    project_arn = os.environ.get("PARSE_BAKEOFF_BDA_PROJECT")
    if not bucket or not project_arn:
        raise RuntimeError("PARSE_BAKEOFF_BUCKET / PARSE_BAKEOFF_BDA_PROJECT not set")
    region = os.environ.get("PARSE_BAKEOFF_BDA_REGION", "us-east-1")
    account = project_arn.split(":")[4]
    profile_arn = (f"arn:aws:bedrock:{region}:{account}:"
                   "data-automation-profile/us.data-automation-v1")

    s3 = boto3.client("s3", region_name=region)
    rt = boto3.client("bedrock-data-automation-runtime", region_name=region)

    key_in = f"input/{doc['file']}"
    prefix_out = f"output/{doc['external_id']}"
    s3.put_object(Bucket=bucket, Key=key_in, Body=pdf_bytes)

    job = rt.invoke_data_automation_async(
        inputConfiguration={"s3Uri": f"s3://{bucket}/{key_in}"},
        outputConfiguration={"s3Uri": f"s3://{bucket}/{prefix_out}"},
        dataAutomationConfiguration={"dataAutomationProjectArn": project_arn,
                                     "stage": "LIVE"},
        dataAutomationProfileArn=profile_arn,
    )
    arn = job["invocationArn"]
    while True:
        st = rt.get_data_automation_status(invocationArn=arn)
        if st["status"] in ("Success", "ServiceError", "ClientError"):
            break
        time.sleep(5)
    if st["status"] != "Success":
        raise RuntimeError(f"BDA job {st['status']}: {st.get('errorMessage')}")

    meta_uri = st["outputConfiguration"]["s3Uri"]  # job_metadata.json
    def _read(uri):
        b, k = uri.replace("s3://", "").split("/", 1)
        return json.loads(s3.get_object(Bucket=b, Key=k)["Body"].read())

    meta = _read(meta_uri)
    texts = []
    pages_parsed = 0
    for seg in meta.get("output_metadata", []):
        for seg_meta in seg.get("segment_metadata", []):
            if "standard_output_path" in seg_meta:
                std = _read(seg_meta["standard_output_path"])
                doc_out = std.get("document", {})
                rep = doc_out.get("representation", {})
                texts.append(rep.get("markdown") or rep.get("text") or "")
                pages_parsed += len(std.get("pages", []))
    markdown = "\n\n".join(t for t in texts if t)
    return {"full_text": markdown, "markdown": markdown,
            "pages_parsed": pages_parsed}


BACKENDS = {"pypdf": parse_pypdf, "bda": parse_bda,
            "gemini": parse_gemini, "mistral": parse_mistral}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in BACKENDS:
        print(f"usage: parse_fixture.py {{{'|'.join(BACKENDS)}}}")
        return 2
    backend = sys.argv[1]
    manifest = json.load(open(MANIFEST))
    pdf_dir = Path(manifest["pdf_dir"])
    fn = BACKENDS[backend]

    results = []
    for doc in manifest["docs"]:
        pdf_bytes = (pdf_dir / doc["file"]).read_bytes()
        t0 = time.time()
        try:
            out = fn(pdf_bytes, doc)
            row = {**{k: doc[k] for k in
                      ("external_id", "language", "category")},
                   "pages_expected": doc["pages"],
                   "chars": len(out["full_text"]),
                   "wall_ms": int((time.time() - t0) * 1000), **out}
            print(f"{doc['external_id']}: {row['chars']} chars, "
                  f"{row.get('pages_parsed', '?')} pages, "
                  f"{row['wall_ms']}ms", flush=True)
        except Exception as e:  # keep going; record the failure
            row = {**{k: doc[k] for k in
                      ("external_id", "language", "category")},
                   "pages_expected": doc["pages"],
                   "wall_ms": int((time.time() - t0) * 1000),
                   "error": f"{type(e).__name__}: {e}"}
            print(f"{doc['external_id']}: ERROR {row['error']}", flush=True)
        results.append(row)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"parse-fixture-{backend}.json"
    json.dump({"parser": backend, "timestamp": int(time.time()),
               "results": results}, open(out_path, "w"))
    print(f"saved {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
