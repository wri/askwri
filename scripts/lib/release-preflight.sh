# scripts/lib/release-preflight.sh
#
# The release tools run from a git checkout, not from a deployed image, so a stale
# clone silently executes old logic against production. Compare the running files
# with the reviewed copies on origin/qa.
#
# Sourced by mirror-qa-to-production.sh and fingerprint-corpus.sh, which verify this
# file themselves before sourcing it (a stale copy cannot vouch for itself).
#
#   require_current_release_tool <apply: 0|1> <repo-relative path>...
#
# Read-only runs (mirror dry run, fingerprint) warn and continue so a change can be
# tested, including offline or outside a checkout; --apply refuses, because that is
# where stale logic writes to production.
#
# Comparison is by git object id (hash-object of the working file vs the blob on
# origin/qa), so untracked files and subdirectory runs are both handled.
#
# Scope: the paths passed in. Migrations and src/ are not compared.
# Tests: scripts/tests/test_release_preflight.sh

require_current_release_tool() {
  local apply="$1" top behind path stale=0 expected actual
  shift

  # Anchor every git call at the repo root: a cwd-relative pathspec silently matches
  # nothing from a subdirectory and would report a stale file as current.
  top=$(git rev-parse --show-toplevel 2>/dev/null)
  if [ -z "$top" ]; then
    if [ "$apply" = "1" ]; then
      echo "  FAIL not inside a git checkout — cannot verify the release tooling"
      exit 1
    fi
    echo "  WARN not inside a git checkout — read-only run continues unchecked"
    return 0
  fi

  if ! git -C "$top" fetch --quiet origin 2>/dev/null; then
    if [ "$apply" = "1" ]; then
      echo "  FAIL cannot reach origin to verify the release tooling — check the network and re-run"
      exit 1
    fi
    echo "  WARN cannot reach origin — read-only run continues unchecked"
    return 0
  fi

  if ! git -C "$top" rev-parse --verify --quiet origin/qa >/dev/null; then
    if [ "$apply" = "1" ]; then
      echo "  FAIL origin/qa not found — cannot verify the release tooling"
      exit 1
    fi
    echo "  WARN origin/qa not found — read-only run continues unchecked"
    return 0
  fi

  behind=$(git -C "$top" rev-list --count HEAD..origin/qa 2>/dev/null || echo 0)
  if [ "${behind:-0}" -gt 0 ] 2>/dev/null; then
    echo "  WARN checkout is $behind commit(s) behind origin/qa"
  fi

  for path in "$@"; do
    expected=$(git -C "$top" rev-parse "origin/qa:$path" 2>/dev/null) || expected=""
    actual=$(git -C "$top" hash-object --path="$path" -- "$path" 2>/dev/null) || actual=""
    if [ -n "$expected" ] && [ "$expected" = "$actual" ]; then
      echo "  OK   $path matches origin/qa"
      continue
    fi
    stale=1
    if [ -z "$expected" ]; then
      echo "  DIFF $path is not tracked in origin/qa"
    elif [ -z "$actual" ]; then
      echo "  DIFF $path is missing from this checkout"
    else
      echo "  DIFF $path differs from origin/qa:"
      git -C "$top" diff --stat origin/qa -- "$path" | sed 's/^/       /'
    fi
  done
  [ "$stale" = "0" ] && return 0

  if [ "$apply" = "1" ]; then
    echo "  FAIL refusing to --apply: release tooling must match origin/qa."
    echo "       merge the change to qa and pull it into this checkout first"
    exit 1
  fi
  echo "  WARN stale release logic — read-only run continues; --apply will refuse"
}
