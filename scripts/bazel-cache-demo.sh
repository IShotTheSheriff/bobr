#!/usr/bin/env bash
#
# Bóbr — Bazel selective-cache demo.
#
# Proves the PoC's thesis: changing shared code that app A uses (but app B does
# not) re-runs only A's checks; B's are restored from cache. And when a change
# compiles to byte-identical output, even A's downstream tests are skipped.
#
# Everything here is driven by Bazel's content-addressed action graph + the
# --disk_cache configured in .bazelrc. No hand-rolled output hashing.
#
# Usage:  ./scripts/bazel-cache-demo.sh
set -euo pipefail

cd "$(dirname "$0")/.."

ADD=packages/ui/src/utils/add/index.ts
SUB=packages/ui/src/utils/sub/index.ts

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
rule() { printf '\033[2m%s\033[0m\n' "────────────────────────────────────────────────────────────"; }

# Always restore edited sources, even on Ctrl-C / failure.
restore() { git checkout -- "$ADD" "$SUB" 2>/dev/null || true; }
trap restore EXIT

# Show per-target test status (cached vs executed) plus the process summary,
# which is Bazel's own proof of what actually ran.
run_tests() {
  bazel test //apps/web:test //apps/docs:test "$@" 2>&1 \
    | grep -E "PASSED|FAILED|cached|processes:" || true
}

rule
bold "STEP 0 — Warm the cache (build + test the whole graph once)"
bold "        After this, a no-op re-run is 100% cache hits."
rule
bazel test //... 2>&1 | grep -E "PASSED|FAILED|cached|tests? pass|processes:" || true
echo
bold "  Re-run with no changes → everything is a cache hit:"
run_tests

rule
bold "PROOF (static): is add/index.ts an input to each app's test graph?"
rule
echo "  docs:test actions that consume add/index.ts  (expect: none):"
bazel aquery 'inputs(".*/utils/add/index\.ts", deps(//apps/docs:test))' 2>/dev/null \
  | grep -E "^action|add/index\.ts" | sed 's/^/    /' || true
echo "    -> (empty = docs can never be invalidated by add/index.ts)"
echo
echo "  web:test actions that consume add/index.ts   (expect: at least one):"
bazel aquery 'inputs(".*/utils/add/index\.ts", deps(//apps/web:test))' 2>/dev/null \
  | grep -cE "^action '" | sed 's/^/    matching actions: /' || true

rule
bold "SCENARIO 1 — Change add/index.ts (used by web, NOT docs); behavior preserved"
bold "  Expect: web re-validates, docs is fully CACHED."
rule
cat > "$ADD" <<'EOF'
export const add = (a: number) => {
  return a + 6 + 6; // same result (12), different source -> recompiles
};
EOF
run_tests
restore

rule
bold "SCENARIO 2 — Whitespace-only change to add/index.ts (compiles byte-identical)"
bold "  Expect: :add recompiles, but BOTH tests are CACHED (output-stable cascade)."
bold "  This is 'rebuild the app, skip the test because the bundle is identical'."
rule
bazel test //... >/dev/null 2>&1 # re-warm
cat > "$ADD" <<'EOF'
export const add = (a: number) => {


  return a + 12;

};
EOF
run_tests
restore

rule
bold "SCENARIO 3 — Change sub/index.ts (used by docs, NOT web); the mirror image"
bold "  Expect: docs re-validates, web is fully CACHED."
rule
bazel test //... >/dev/null 2>&1 # re-warm
cat > "$SUB" <<'EOF'
export const sub = (a: number) => {
  return a - 2 - 3; // same result (-5), different source -> recompiles
};
EOF
run_tests
restore

rule
bold "Done. Sources restored. Re-run any time — the disk cache persists across runs."
rule
