#!/usr/bin/env bash
# Checks for scripts/lib/release-preflight.sh in a throwaway repo with a bare origin.
# Run directly: bash scripts/tests/test_release_preflight.sh
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
lib="$here/../lib/release-preflight.sh"
fail=0
dirs=()

cleanup() { cd / || true; rm -rf "${dirs[@]}"; }
trap cleanup EXIT

check() { # <name> <expected exit> <actual exit>
  if [ "$2" != "$3" ]; then
    echo "FAIL $1 (expected exit $2, got $3)"
    fail=1
  else
    echo "ok   $1"
  fi
}

expect_out() { # <name> <pattern> <output>
  case "$3" in
    *"$2"*) echo "ok   $1" ;;
    *) echo "FAIL $1 (missing: $2)"; echo "     got: $3"; fail=1 ;;
  esac
}

setup() {
  T=$(mktemp -d)
  dirs+=("$T")
  git init -q --bare "$T/origin.git"
  git init -q "$T/work"
  cd "$T/work" || exit 1
  git config user.email test@example.com
  git config user.name test
  mkdir -p scripts/lib
  cp "$lib" scripts/lib/release-preflight.sh
  printf '#!/usr/bin/env bash\necho tool\n' > scripts/tool.sh
  git add -A && git commit -qm init && git branch -M qa
  git remote add origin "$T/origin.git" && git push -q origin qa
  git checkout -q -b dev
}

run() { # <apply> <paths...>; prints the helper's exit code
  ( . scripts/lib/release-preflight.sh; require_current_release_tool "$@" ) >/dev/null 2>&1
  echo $?
}

setup; check "current read-only" 0 "$(run 0 scripts/tool.sh scripts/lib/release-preflight.sh)"
setup; check "current apply" 0 "$(run 1 scripts/tool.sh scripts/lib/release-preflight.sh)"

setup; echo "# stale" >> scripts/tool.sh
check "stale read-only proceeds" 0 "$(run 0 scripts/tool.sh scripts/lib/release-preflight.sh)"
check "stale apply refuses" 1 "$(run 1 scripts/tool.sh scripts/lib/release-preflight.sh)"

setup; printf '#!/usr/bin/env bash\necho new\n' > scripts/untracked.sh
check "untracked read-only proceeds" 0 "$(run 0 scripts/untracked.sh)"
check "untracked apply refuses" 1 "$(run 1 scripts/untracked.sh)"

setup; git remote set-url origin "$T/nope.git"
check "offline read-only proceeds" 0 "$(run 0 scripts/tool.sh scripts/lib/release-preflight.sh)"
check "offline apply refuses" 1 "$(run 1 scripts/tool.sh scripts/lib/release-preflight.sh)"

setup; git push -q origin --delete qa; git update-ref -d refs/remotes/origin/qa
check "missing origin/qa read-only proceeds" 0 "$(run 0 scripts/tool.sh scripts/lib/release-preflight.sh)"
check "missing origin/qa apply refuses" 1 "$(run 1 scripts/tool.sh scripts/lib/release-preflight.sh)"

setup; echo "# stale" >> scripts/tool.sh; mkdir -p scripts/sub
out=$( cd scripts/sub && . "$lib" && require_current_release_tool 1 scripts/tool.sh 2>&1 )
expect_out "subdirectory run still detects the stale file" "differs from origin/qa" "$out"

# The real caller must refuse an edited helper, from the root and from a subdirectory.
setup
cp "$here/../mirror-qa-to-production.sh" scripts/mirror-qa-to-production.sh
printf 'require_current_release_tool() { return 0; }\n' > scripts/lib/release-preflight.sh
out=$( bash scripts/mirror-qa-to-production.sh --apply 2>&1 )
expect_out "real caller refuses an edited helper" "release-preflight.sh differs from origin/qa" "$out"
out=$( cd scripts && bash mirror-qa-to-production.sh --apply 2>&1 )
expect_out "real caller refuses an edited helper from a subdirectory" "release-preflight.sh differs from origin/qa" "$out"

cd /tmp
out=$( bash -c 'cd /tmp && . '"$lib"' && require_current_release_tool 0 scripts/tool.sh' 2>&1 ); rc=$?
check "outside a checkout read-only proceeds" 0 "$rc"
out=$( bash -c 'cd /tmp && . '"$lib"' && require_current_release_tool 1 scripts/tool.sh' 2>&1 ); rc=$?
check "outside a checkout apply refuses" 1 "$rc"

[ "$fail" -eq 0 ] && echo "all preflight checks passed" || echo "FAILURES"
exit "$fail"
