#!/usr/bin/env bash
# Checks for scripts/lib/compute-sync-keys.py — the gate that decides whether a
# document may be inserted into the target environment, or would collide with a
# document already there under a different id.
#
# Run directly: bash scripts/tests/test_compute_sync_keys.sh
#
# The collisions it guards are the two unique indexes on documents:
#   UQ_documents_external_id     (external_id) WHERE external_id IS NOT NULL
#   UQ_documents_content_hash    (content_hash) WHERE content_hash IS NOT NULL
# A miss here either aborts a production copy mid-transaction or silently inserts
# a duplicate of a document the target already had.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
lib="$here/../lib/compute-sync-keys.py"
fail=0
dirs=()

cleanup() { rm -rf "${dirs[@]}"; }
trap cleanup EXIT

t=$(mktemp -d); dirs+=("$t")
src="$t/src.txt"; tgt="$t/tgt.txt"; keep="$t/keep.txt"; block="$t/block.txt"

check() { # <name> <expected> <actual>
  if [ "$2" != "$3" ]; then
    echo "FAIL $1 (expected '$2', got '$3')"
    fail=1
  else
    echo "ok   $1"
  fi
}

run() { python3 "$lib" "$src" "$tgt" "$keep" "$block" 2>&1; }

# 1. Same external_id under a different id on the target -> blocked.
cat > "$src" <<'EOF'
aaaa1111|EXT-1|
bbbb2222||hash-1
cccc3333|EXT-3|hash-3
EOF
cat > "$tgt" <<'EOF'
dddd4444|EXT-1|other
eeee5555||hash-1
EOF
run >/dev/null
check "external_id collision leaves only the clean doc" "cccc3333" "$(grep -o '^[a-z0-9]*' "$keep" | paste -sd, -)"
check "external_id collision recorded" "1" "$(grep -c '^aaaa1111|external_id' "$block")"
check "content_hash collision recorded" "1" "$(grep -c '^bbbb2222|content_hash' "$block")"
check "clean document has no block line" "0" "$(grep -c '^cccc3333|' "$block")"

# 2. NULL keys must never match each other — two documents with no external_id
#    and no content_hash are distinct documents, not duplicates.
cat > "$src" <<'EOF'
11111111||
22222222||
EOF
cat > "$tgt" <<'EOF'
33333333||
EOF
run >/dev/null
check "NULL external_id does not collide" "2" "$(wc -l < "$keep" | tr -d ' ')"
check "no false blocks from NULLs"        "0" "$(wc -l < "$block" | tr -d ' ')"

# 3. A document already on the target by id is not this script's problem to insert;
#    it still passes the gate, and the caller's set difference excludes it.
cat > "$src" <<'EOF'
99999999|EXT-9|hash-9
EOF
cat > "$tgt" <<'EOF'
99999999|EXT-9|hash-9
EOF
run >/dev/null
check "same id+keys blocks (target has it)" "1" "$(wc -l < "$block" | tr -d ' ')"

# 4. Malformed input must abort, not guess.
printf 'aa|bb\n' > "$src"
printf '' > "$tgt"
out=$(run); rc=$?
check "malformed candidate line exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
case "$out" in
  *"expected 3 fields"*) echo "ok   malformed line names the problem" ;;
  *) echo "FAIL malformed line names the problem (got: $out)"; fail=1 ;;
esac

# 5. One alias naming several target ids must list them all, not just the first.
cat > "$src" <<'EOF'
77777777||hash-shared
EOF
cat > "$tgt" <<'EOF'
12345678||hash-shared
abcdef01||hash-shared
EOF
run >/dev/null
case "$(cat "$block")" in
  *12345678,abcdef01*|*abcdef01,12345678*)
    echo "ok   both target ids named in the collision" ;;
  *) echo "FAIL both target ids named in the collision (got: $(cat "$block"))"; fail=1 ;;
esac

exit "$fail"
