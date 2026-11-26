#!/usr/bin/env bash
# Checks for scripts/repair-taxonomy.py — the rules that decide what changes
# before a taxonomy CSV goes back through /api/admin/topics/import.
#
# Run directly: bash scripts/tests/test_repair_taxonomy.sh
#
# The import replaces a tag's aliases wholesale and renames by id, so a wrong
# rule here either deletes an alias that was doing useful work or renames a tag
# onto a label another tag already owns (which aborts the whole import).
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tool="$here/../repair-taxonomy.py"
fail=0
dirs=()

cleanup() { rm -rf "${dirs[@]}"; }
trap cleanup EXIT

t=$(mktemp -d); dirs+=("$t")

check() { # <name> <expected> <actual>
  if [ "$2" != "$3" ]; then
    echo "FAIL $1 (expected '$2', got '$3')"
    fail=1
  else
    echo "ok   $1"
  fi
}

# A fixture carrying one of each defect class the tool claims to handle, plus
# aliases it must NOT touch.
cat > "$t/in.csv" <<'EOF'
label,description,aliases,parent,facet,id
Umbrella,,child-one|own-alias|broader term,,topic,11111111-0000-0000-0000-000000000001
Child One,,,,topic,22222222-0000-0000-0000-000000000002
Comuting,,,,topic,33333333-0000-0000-0000-000000000003
Standalone,,solo,,topic,44444444-0000-0000-0000-000000000004
EOF

python3 "$tool" "$t/in.csv" -o "$t/out.csv" > "$t/log.txt" 2>&1
# Guard the whole test on the output existing: a missing file makes every grep
# below fail in a way that can read as a pass.
if [ ! -f "$t/out.csv" ]; then
  echo "FAIL repair produced no output file:"
  sed 's/^/     /' "$t/log.txt"
  exit 1
fi

# 1. An alias naming its own label is duplicated at worst, never a collision.
python3 "$tool" "$t/in.csv" --check >/dev/null 2>&1; rc=$?
check "check exits non-zero while defects remain" "1" "$rc"

# 2. The collision and the misspelling are gone from the fixed file.
python3 "$tool" "$t/out.csv" --check >/dev/null 2>&1
check "repaired file passes --check" "0" "$?"

check "misspelling renamed"   "1" "$(grep -c '^Commuting,' "$t/out.csv")"
check "old label gone"        "0" "$(grep -c '^Comuting,' "$t/out.csv")"

# 3. The collision alias is dropped, the genuinely useful ones survive. A broad
#    alias that merely CONTAINS another tag's words must be kept — deleting it
#    would cost recall for no ambiguity.
umbrella=$(grep '^Umbrella,' "$t/out.csv")
case "$umbrella" in
  *child-one*) echo "FAIL umbrella lost its sibling-naming alias"; fail=1 ;;
  *) echo "ok   sibling-naming alias removed" ;;
esac
case "$umbrella" in
  *own-alias*) echo "ok   own-label alias kept" ;;
  *) echo "FAIL own-label alias wrongly removed"; fail=1 ;;
esac
case "$umbrella" in
  *broader*) echo "ok   unrelated alias kept" ;;
  *) echo "FAIL unrelated alias wrongly removed"; fail=1 ;;
esac

# 4. Row count and untouched rows survive the round trip.
check "row count preserved" "4" "$(($(wc -l < "$t/out.csv" | tr -d ' ') - 1))"
check "aliasless row untouched" "Standalone,,solo,,topic,44444444-0000-0000-0000-000000000004" \
  "$(grep '^Standalone,' "$t/out.csv")"

# 5. Idempotent: repairing the repaired file changes nothing.
python3 "$tool" "$t/out.csv" -o "$t/out2.csv" >/dev/null 2>&1
if diff -q "$t/out.csv" "$t/out2.csv" >/dev/null; then
  echo "ok   idempotent"
else
  echo "FAIL idempotent (second pass changed the file)"; fail=1
fi

# 6. A CSV without the managed header must fail loudly, not emit an empty repair.
printf 'keyword,count\nfoo,1\n' > "$t/bad.csv"
python3 "$tool" "$t/bad.csv" -o "$t/bad-out.csv" > "$t/bad-log.txt" 2>&1; rc=$?
check "headerless CSV exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
case "$(cat "$t/bad-log.txt")" in
  *"missing column"*) echo "ok   headerless CSV names the missing columns" ;;
  *) echo "FAIL headerless CSV names the missing columns (got: $(cat "$t/bad-log.txt"))"; fail=1 ;;
esac

# 7. A rename onto a label another tag already owns must be refused upstream by
#    the import, so the tool must never manufacture one: every RENAMES target is
#    asserted absent from a real export. Here we only prove the tool does not
#    invent collisions between two fixture rows it renames together.
cat > "$t/pair.csv" <<'EOF'
label,description,aliases,parent,facet,id
Comuting,,,,topic,55555555-0000-0000-0000-000000000005
Commuting,,,,topic,66666666-0000-0000-0000-000000000006
EOF
python3 "$tool" "$t/pair.csv" -o "$t/pair-out.csv" > "$t/pair-log.txt" 2>&1; rc=$?
if [ "$rc" -ne 0 ]; then
  echo "ok   rename onto an occupied label is reported, not silently emitted"
else
  echo "FAIL rename onto an occupied label was emitted silently"; fail=1
fi

exit "$fail"
