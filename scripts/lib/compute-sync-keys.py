#!/usr/bin/env python3
"""Decide which documents sync-corpus.sh may insert into the target.

Reads two "id|external_id|content_hash" key files (empty field = NULL) and splits
the candidates into insertable and blocked. A candidate is blocked when the target
already holds a document with the same external_id or the same content_hash under a
different id: inserting it would violate UQ_documents_external_id or
UQ_documents_content_hash.

Writes "<id>" lines to insertable_path and "<id>|<reason>" lines to blocked_path.
Exits non-zero on a malformed line rather than guessing, because the guess would be
made against production.

    compute-sync-keys.py <source-keys> <target-keys> <insertable-out> <blocked-out>
"""
import sys


def load(path):
    """Parse an id|external_id|content_hash file. Missing trailing fields are NULL."""
    rows = {}
    with open(path) as fh:
        for n, line in enumerate(fh, 1):
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split("|")
            if len(parts) != 3:
                raise SystemExit(f"{path}:{n}: expected 3 fields, got {len(parts)}: {line!r}")
            doc_id, ext, chash = parts
            if not doc_id:
                raise SystemExit(f"{path}:{n}: empty document id")
            rows[doc_id] = (ext, chash)
    return rows


def main(argv):
    if len(argv) != 5:
        raise SystemExit(__doc__.strip().splitlines()[-1])
    src_path, tgt_path, keep_path, block_path = argv[1:5]

    target = load(tgt_path)
    by_ext, by_hash = {}, {}
    for doc_id, (ext, chash) in target.items():
        if ext:
            by_ext[ext] = doc_id
        if chash:
            by_hash.setdefault(chash, []).append(doc_id)

    keep, blocked = [], []
    for doc_id, (ext, chash) in load(src_path).items():
        reasons = []
        if ext and ext in by_ext:
            reasons.append(f"external_id already on target as {by_ext[ext]}")
        if chash and chash in by_hash:
            reasons.append(f"content_hash already on target as {','.join(x[:8] for x in by_hash[chash])}")
        if reasons:
            blocked.append((doc_id, " AND ".join(reasons)))
        else:
            keep.append(doc_id)

    with open(keep_path, "w") as fh:
        fh.write("".join(f"{i}\n" for i in keep))
    with open(block_path, "w") as fh:
        fh.write("".join(f"{i}|{why}\n" for i, why in blocked))
    return len(keep), len(blocked)


if __name__ == "__main__":
    keep, blocked = main(sys.argv)
    print(f"  SKIP {blocked:3d}  the target already has this document under another id")
    print(f"  COPY {keep:3d}  insertable")
    for line in open(sys.argv[4]):
        doc_id, why = line.rstrip("\n").split("|", 1)
        print(f"        {doc_id[:8]}  {why}")
