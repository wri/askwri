"""Parser candidates through WRI's OpenRouter account.

A page set is a folder holding manifest.json (prompt, documents with
selected_pdf_pages, optional models and render_scale), source-pages/ with one
PDF per page and, for image-only models, renders/. build_set.py and
build_v2refs.py make one; the 24 November smoke folder (qa/manifest.json) also works.
Mistral OCR is the pseudo-model id "mistral-ocr" (OpenRouter's file-parser engine).

File-capable models get the exact single-page PDF; image-only models get the
set's PNG render. Each row records its transport. Models run in parallel,
pages within a model run in order.

Usage:
  python3 run_openrouter.py --set-key               # store the key in the login Keychain once
  python3 run_openrouter.py --set DIR [model-id ...]
  (key: OPENROUTER_API_KEY, else the Keychain item, else a hidden prompt that then stores it;
   never written to any output)

Outputs: <set>/openrouter/<model-id-with-__>/<page>.md, --raw.json, results.json
"""
import base64, hashlib, json, os, pathlib, sys, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

DEFAULT_MODELS = [
    "anthropic/claude-sonnet-5.5",
    "thinkingmachines/inkling-2-mini",
    "thinkingmachines/inkling-2-small",
    "google/gemini-3.8-flash",
    "inclusionai/ling-3.0-flash-vl",
]
API = "https://openrouter.ai/api/v1"

args = sys.argv[1:]
SET = None
if args[:1] == ["--set"]:
    SET = pathlib.Path(args[1]).resolve()
    args = args[2:]
if args[:1] != ["--set-key"]:
    if SET is None:
        sys.exit("Usage: run_openrouter.py --set DIR [model-id ...]  (or --set-key)")
    manifest_path = SET / "manifest.json" if (SET / "manifest.json").exists() else SET / "qa" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    prompt = manifest["prompt"]
    models = args or manifest.get("models") or DEFAULT_MODELS

import subprocess
KC = ["-a", "askwri-parser-eval", "-s", "openrouter-api-key"]


def keychain_get():
    r = subprocess.run(["security", "find-generic-password", *KC, "-w"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def keychain_set(value):
    # Fed through `security -i` on stdin so the key never appears in a process argument list.
    if not value.startswith("sk-") or not all(c.isalnum() or c in "-_" for c in value):
        sys.exit("That doesn't look like an OpenRouter key (expected sk-...); nothing stored.")
    cmd = f"add-generic-password -U {' '.join(KC)} -w {value}\n"
    r = subprocess.run(["security", "-i"], input=cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("Could not store the key in the login Keychain.")


def prompt_key():
    import getpass
    for _ in range(3):
        value = getpass.getpass("OpenRouter API key (input hidden, stored in your login Keychain): ").strip()
        if value:
            return value
        print("Nothing was entered; paste the key, then press Enter.")
    return ""


if args[:1] == ["--set-key"]:
    if not sys.stdin.isatty():
        sys.exit("--set-key needs an interactive terminal.")
    keychain_set(prompt_key())
    print("Stored in the login Keychain (account askwri-parser-eval, service openrouter-api-key). Runs will use it from now on.")
    sys.exit(0)

key = os.environ.get("OPENROUTER_API_KEY") or keychain_get()
if not key and sys.stdin.isatty():
    key = prompt_key()
    if key:
        keychain_set(key)
if not key:
    sys.exit("No OpenRouter key (environment, Keychain or prompt); nothing was sent.")

stop = threading.Event()
print_lock = threading.Lock()


def call(path, body=None):
    req = urllib.request.Request(
        API + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


catalog = {m["id"]: m for m in call("/models")[1]["data"]}


MISTRAL_CARRIER = "upstage/solar-mini-4-5"  # cheapest text model; only carries the file-parser call


def mistral_ocr_text(raw):
    """Mistral OCR's own transcription, from the file-parser annotation (not the carrier model's reply)."""
    parts = []
    for ann in ((raw.get("choices") or [{}])[0].get("message") or {}).get("annotations") or []:
        content = (ann.get("file") or {}).get("content") or []
        for c in content if isinstance(content, list) else [content]:
            parts.append(c.get("text", "") if isinstance(c, dict) else str(c))
    return "\n\n".join(p for p in parts if p)


def run_model(model):
    if model == "mistral-ocr":
        return run_mistral_ocr()
    if model not in catalog:
        with print_lock:
            print("SKIP", model, "not in OpenRouter catalog", flush=True)
        return
    takes_file = "file" in catalog[model]["architecture"]["input_modalities"]
    out = SET / "openrouter" / model.replace("/", "__")
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for doc in manifest["documents"]:
        for page in doc["selected_pdf_pages"]:
            if stop.is_set():
                return
            ident = f"{doc['id']}--p{page}"
            pdf = (SET / "source-pages" / f"{ident}.pdf").read_bytes()
            if takes_file:
                part = {"type": "file", "file": {"filename": "page.pdf",
                        "file_data": "data:application/pdf;base64," + base64.b64encode(pdf).decode()}}
                extra = {"plugins": [{"id": "file-parser", "pdf": {"engine": "native"}}]}
                transport = "pdf-native"
            else:
                png = (SET / "renders" / f"{ident}.png").read_bytes()
                part = {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}}
                extra = {}
                transport = "png-" + manifest.get("render_scale", "1.5x")
            body = {"model": model, "max_tokens": 24000, "usage": {"include": True},
                    "messages": [{"role": "user", "content": [part, {"type": "text", "text": prompt}]}], **extra}
            row = {"id": doc["id"], "page": page, "language": doc["actual_language"], "model": model,
                   "transport": transport, "input_sha256": hashlib.sha256(pdf).hexdigest(),
                   "settings": {"max_tokens": 24000, "reasoning": "model default", "temperature": "model default"}}
            t = time.monotonic()
            try:
                status, raw = call("/chat/completions", body)
                (out / f"{ident}--raw.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2))
                row["http_status"] = status
                choice = (raw.get("choices") or [{}])[0]
                text = (choice.get("message") or {}).get("content") or ""
                if status == 200 and text:
                    (out / f"{ident}.md").write_text(text)
                row.update(status="ok" if status == 200 and text and choice.get("finish_reason") == "stop" else "incomplete" if status == 200 else "error",
                           finish_reason=choice.get("finish_reason"), provider=raw.get("provider"),
                           response_model=raw.get("model"), usage=raw.get("usage"), chars=len(text), error=raw.get("error"))
            except Exception as e:
                row.update(status="error", error_type=type(e).__name__, error=str(e).replace(key, "[REDACTED]"))
            row["wall_seconds"] = round(time.monotonic() - t, 3)
            rows.append(row)
            (out / "results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
            with print_lock:
                print("OPENROUTER", model, doc["actual_language"], page, row["status"], row.get("chars"),
                      (row.get("usage") or {}).get("cost"), flush=True)
            if row.get("http_status") in (401, 402, 403):
                stop.set()
                with print_lock:
                    print(f"Stopped: HTTP {row['http_status']} from OpenRouter (check key or credit).", flush=True)
                return


def run_mistral_ocr():
    """Mistral OCR through OpenRouter's file-parser engine ($2 per 1,000 pages). The
    carrier model is told to reply 'OK'; the transcription is the parser's annotation."""
    out = SET / "openrouter" / "mistral-ocr"
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for doc in manifest["documents"]:
        for page in doc["selected_pdf_pages"]:
            if stop.is_set():
                return
            ident = f"{doc['id']}--p{page}"
            pdf = (SET / "source-pages" / f"{ident}.pdf").read_bytes()
            body = {"model": MISTRAL_CARRIER, "max_tokens": 8, "usage": {"include": True},
                    "plugins": [{"id": "file-parser", "pdf": {"engine": "mistral-ocr"}}],
                    "messages": [{"role": "user", "content": [
                        {"type": "file", "file": {"filename": "page.pdf", "file_data": "data:application/pdf;base64," + base64.b64encode(pdf).decode()}},
                        {"type": "text", "text": "Reply with OK."}]}]}
            row = {"id": doc["id"], "page": page, "language": doc["actual_language"], "model": "mistral-ocr",
                   "transport": "openrouter file-parser engine mistral-ocr", "carrier": MISTRAL_CARRIER,
                   "input_sha256": hashlib.sha256(pdf).hexdigest()}
            t = time.monotonic()
            try:
                status, raw = call("/chat/completions", body)
                (out / f"{ident}--raw.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2))
                text = mistral_ocr_text(raw) if status == 200 else ""
                if text:
                    (out / f"{ident}.md").write_text(text)
                row.update(http_status=status, status="ok" if text else "no-annotation" if status == 200 else "error",
                           usage=raw.get("usage"), chars=len(text), error=raw.get("error"))
            except Exception as e:
                row.update(status="error", error_type=type(e).__name__, error=str(e).replace(key, "[REDACTED]"))
            row["wall_seconds"] = round(time.monotonic() - t, 3)
            rows.append(row)
            (out / "results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
            with print_lock:
                print("OPENROUTER mistral-ocr", doc["actual_language"], page, row["status"], row.get("chars"),
                      (row.get("usage") or {}).get("cost"), flush=True)
            if row.get("http_status") in (401, 402, 403):
                stop.set()
                return


with ThreadPoolExecutor(max_workers=len(models)) as pool:
    list(pool.map(run_model, models))
print("DONE", flush=True)
