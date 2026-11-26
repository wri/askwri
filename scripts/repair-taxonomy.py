#!/usr/bin/env python3
"""Repair the mechanical defects in a topic-taxonomy export.

Takes the CSV that /api/admin/topics/export produces
(label,description,aliases,parent,facet,id) and emits a repaired copy plus a
human-readable list of every change. The repaired file is what you POST to
/api/admin/topics/import; this script never touches a database.

WHY A SCRIPT AND NOT A HAND-EDITED CSV
    Editing 757 rows by hand makes review impossible and re-running impossible.
    Staff edit the taxonomy through the DMS on production, so the next export
    will differ; a rule you can re-apply is worth more than a one-off file.

WHAT IT REPAIRS (and only this)
    * Encoding damage. A U+FFFD replacement character means the original byte
      was lost on the way in and is unrecoverable, so the label is restored from
      the known-correct spelling in RENAMES rather than guessed.
    * Misspellings, likewise from an explicit table.
    * Any alias whose normalised form equals another topic's label — the
      umbrella-carries-its-own-child defect. Retrieval embeds label + aliases +
      description (search-service/worker/stages/embed_tags.py), so such an alias
      pulls a document toward the umbrella and the specific tag at once, with
      nothing to break the tie.

WHAT IT DELIBERATELY DOES NOT DO
    * No synonym merges, no tag deletion, no descriptions. Those change what
      existing document_tags rows mean and need a decision, not a rule.
    * No fuzzy alias matching. A broad alias inside a narrower tag's name is
      correct (alias 'climate' inside the tag 'Climate Action'); deleting those
      would destroy useful recall. Cases that are the same concept under two
      spellings are listed under RESIDUAL for a human to settle, not edited.

    python3 scripts/repair-taxonomy.py <export.csv> [-o out.csv] [--check]

--check exits 1 if any repairable defect remains, which is the gate the issue's
definition of done asks for.
"""
import argparse
import csv
import io
import re
import sys

# Labels restored from the known-correct spelling. The original character is
# gone (U+FFFD, not a mis-render), so these cannot be derived — they are
# assertions about what the document taxonomy is supposed to say.
RENAMES = {
    "Escaz\ufffd Agreement": "Escaz\u00fa Agreement",
    "K\ufffdppen Climate Classification": "K\u00f6ppen Climate Classification",
    "United Nations Framework Convention on Climate Change\ufffd":
        "United Nations Framework Convention on Climate Change",
    # Misspellings. Each correct form was verified absent from the export first,
    # so a rename cannot collide with an existing tag ("label belongs to another
    # topic" aborts the whole import).
    "Comuting": "Commuting",
    "Urban Envrionment": "Urban Environment",
    "Battery Data Mangement": "Battery Data Management",
}

# Same concept, two spellings, where the spelling variant sits as an alias while
# the tag exists. Not edited automatically: removing an alias costs recall, and
# whether the corpus should route "decarbonisation" to Climate Change or to
# Decarbonization is a taxonomy decision.
RESIDUAL = [
    ("Climate Change", "decarbonisation", "Decarbonization", "British vs American spelling"),
    ("Buses", "public transport", "Public Transit", "abbreviation of the same concept"),
    ("Finance", "investimento", "Investments", "Portuguese alias of an English tag"),
]

FIELDS = ["label", "description", "aliases", "parent", "facet", "id"]


def norm(text):
    """Fold to lowercase alphanumerics for collision detection."""
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def load(path):
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        missing = [f for f in FIELDS if f not in (reader.fieldnames or [])]
        if missing:
            raise SystemExit(f"{path}: missing column(s) {missing}; expected {','.join(FIELDS)}")
        return [dict(row) for row in reader]


def repair(rows):
    """Return (repaired rows, changes, residual). Pure — no I/O."""
    changes = []

    # 1. Renames, by id so the row is unambiguous even if the label is mangled.
    for row in rows:
        old = row["label"]
        if old in RENAMES:
            row["label"] = RENAMES[old]
            # id is optional: the import matches by label when it is absent, so a
            # row here may legitimately be a tag the CSV is adding outright.
            rid = (row.get("id") or "")[:8] or "(new)"
            changes.append(f"rename    id={rid}  {old!r} -> {row['label']!r}")

    labels = {r["label"] for r in rows}
    owners = {}
    for r in rows:
        owners.setdefault(norm(r["label"]), []).append(r["label"])

    # 2. Drop any alias that names another topic tag. An alias equal to its own
    #    label is harmless duplication, so it is left alone.
    for row in rows:
        aliases = [a for a in (row["aliases"] or "").split("|") if a.strip()]
        if not aliases:
            continue
        keep = []
        for alias in aliases:
            siblings = [l for l in owners.get(norm(alias), []) if l != row["label"]]
            if siblings:
                changes.append(
                    f"unalias   {row['label']!r}  drop {alias!r} (also a tag: {', '.join(sorted(siblings))})"
                )
            else:
                keep.append(alias)
        row["aliases"] = "|".join(keep)

    residual = [(u, a, o, why) for u, a, o, why in RESIDUAL
                if u in labels and o in labels and a in (next(
                    (r["aliases"] or "" for r in rows if r["label"] == u), "").split("|"))]
    return rows, changes, residual


def defects(rows):
    """Everything still wrong that this script knows how to detect."""
    found = []
    for r in rows:
        # elif, not two ifs: every U+FFFD label also has a RENAMES entry, and
        # counting it as both an encoding defect and a misspelling inflates the
        # number the operator is asked to trust.
        if "\ufffd" in r["label"]:
            found.append(f"encoding damage in label: {r['label']!r}")
        elif r["label"] in RENAMES:
            found.append(f"misspelled label: {r['label']!r}")
    # Exact duplicates break the import outright ('duplicate label' conflict), and
    # this tool can create one by renaming onto a label that already exists — so
    # it has to catch its own output. Case-only duplicates (PCS/PCs) are a
    # different defect that the import permits, so they are not flagged here.
    seen = {}
    for r in rows:
        seen[r["label"]] = seen.get(r["label"], 0) + 1
    for label, count in seen.items():
        if count > 1:
            found.append(f"duplicate label {label!r} ({count} rows) — the import will reject this")
    owners = {}
    for r in rows:
        owners.setdefault(norm(r["label"]), []).append(r["label"])
    for r in rows:
        for alias in (r["aliases"] or "").split("|"):
            if not alias.strip():
                continue
            sibs = [l for l in owners.get(norm(alias), []) if l != r["label"]]
            if sibs:
                found.append(f"{r['label']!r} carries alias {alias!r} which is also the tag {sibs[0]!r}")
    return found


def write(rows, path):
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=FIELDS, lineterminator="\n",
                            quoting=csv.QUOTE_MINIMAL)
    writer.writeheader()
    writer.writerows(rows)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(buf.getvalue())


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", help="taxonomy export to repair")
    ap.add_argument("-o", "--out", help="write the repaired CSV here")
    ap.add_argument("--check", action="store_true",
                    help="report remaining defects and exit 1 if any; writes nothing")
    args = ap.parse_args(argv)

    rows = load(args.csv)

    if args.check:
        found = defects(rows)
        for line in found:
            print(line)
        print(f"\n{len(found)} defect(s) in {args.csv}")
        return 1 if found else 0

    rows, changes, residual = repair(rows)
    if args.out:
        write(rows, args.out)

    for line in changes:
        print(line)
    print(f"\n{len(changes)} change(s) across {len(rows)} rows")
    if residual:
        print("\nRESIDUAL — not edited, needs a decision:")
        for umb, alias, tag, why in residual:
            print(f"  {umb!r} keeps alias {alias!r}; the tag {tag!r} exists ({why})")

    left = defects(rows)
    if left:
        print("\nSTILL DEFECTIVE:")
        for line in left:
            print(f"  {line}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
