"""Generate a tiny unique PDF for local worker e2e testing.

Each run embeds a timestamp so the content hash is unique (intake dedupes on
content_hash — re-dropping identical bytes is skipped as a duplicate). Emits
~15 lines of text so extraction confidence clears the searchable gate
(quality_min_chars_per_page=200).

Usage: ./venv/bin/python -m scripts.make_canary_pdf [outdir]
Prints the file path and the canary phrase to query for.
"""
import sys
import time
from pathlib import Path


def make_pdf(lines: list[str]) -> bytes:
    parts = ["BT /F1 12 Tf 72 740 Td 16 TL"]
    for line in lines:
        safe = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        parts.append(f"({safe}) Tj T*")
    parts.append("ET")
    stream = " ".join(parts).encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_at}\n%%EOF\n"
    ).encode()
    return bytes(out)


def main() -> None:
    outdir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp")
    stamp = int(time.time())
    phrase = f"askwri local e2e canary {stamp}"
    lines = [f"{phrase} — line {i}: sustainable urban mobility test corpus filler text." for i in range(15)]
    path = outdir / f"askwri-canary-{stamp}.pdf"
    path.write_bytes(make_pdf(lines))
    print(f"wrote {path}")
    print(f"canary phrase: {phrase}")


if __name__ == "__main__":
    main()
