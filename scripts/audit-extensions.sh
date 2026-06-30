#!/usr/bin/env bash
# Final cleanup audit for the Extension package model.
# One pass proves:
#   - The seven Extension packages build and typecheck
#   - No code depends on the removed shared support
#   - Reference docs and shipped settings no longer mention stale legacy paths
#   - Root metadata, scripts, and reference docs agree on the Extension package story
#
# Exit non-zero on any failure; intended to be run from the repo root.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

EXPECTED=("lsp" "question" "statusline" "subagents" "todo" "web-fetch" "web-search")
FAIL=0

note() { printf "  \033[36m·\033[0m %s\n" "$*"; }
ok() { printf "  \033[32m✓\033[0m %s\n" "$*"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$*"; FAIL=1; }

heading() { printf "\n\033[1m== %s ==\033[0m\n" "$*"; }

heading "Extension package contracts"
note "filter targets exactly the seven canonical packages"
FILTERED=$(pnpm list -r --filter "@epr3/pi-extension-*" --depth -1 2>/dev/null \
  | grep -oE '@epr3/pi-extension-[-a-z]+' | sort -u)
GOT=()
for name in "${EXPECTED[@]}"; do
  if printf "%s\n" "$FILTERED" | grep -qx "@epr3/pi-extension-$name"; then
    GOT+=("@epr3/pi-extension-$name")
  else
    bad "missing Extension package: $name"
  fi
done
EXTRA=$(printf "%s\n" "$FILTERED" | grep -vF "$(printf '%s\n' "${GOT[@]}")" || true)
if [ -n "${EXTRA:-}" ]; then
  bad "filter matched packages not in canonical list: $EXTRA"
fi
[ "${#GOT[@]}" -eq 7 ] && ok "seven Extension packages match the filter"

note "package.json name, main, build script present for each"
for name in "${EXPECTED[@]}"; do
  PJ="$ROOT/packages/$name/package.json"
  if [ ! -f "$PJ" ]; then
    bad "missing $PJ"
    continue
  fi
  for field in '"name"' '"main"' '"build"' '"typecheck"'; do
    grep -q "$field" "$PJ" || bad "$name: package.json missing $field"
  done
done
[ $FAIL -eq 0 ] && ok "all Extension packages have minimal package metadata"

heading "Package-level build + typecheck"
note "pnpm build:ext"
pnpm build:ext >/dev/null 2>&1 && ok "build:ext passes for all seven" \
  || bad "build:ext failed"

note "pnpm typecheck:ext"
pnpm typecheck:ext >/dev/null 2>&1 && ok "typecheck:ext passes for all seven" \
  || bad "typecheck:ext failed"

heading "No code imports from removed shared support"
note "no 'shared/' import path in any Extension package source"
HITS=$(rg -n --no-heading -g '*.ts' \
  -e "from\s+['\"][^'\"]*shared(/|['\"])" \
  -e "require\(['\"][^'\"]*shared/" \
  "$ROOT/packages" 2>/dev/null || true)
# Exclude comments about the inline settings loader ("no shared loader")
HITS=$(printf "%s\n" "$HITS" | grep -v "no shared loader" || true)
if [ -n "${HITS:-}" ]; then
  bad "code still references shared/: $HITS"
else
  ok "no Extension package imports from shared/"
fi

note "packages/shared/ directory does not exist"
if [ -e "$ROOT/packages/shared" ]; then
  bad "packages/shared/ exists (should be removed)"
else
  ok "packages/shared/ is gone"
fi

heading "No stale legacy extension paths in docs or settings"
note "no 'pi-tools/' anywhere in repo code or reference docs"
HITS=$(rg -n --no-heading \
  -g '!node_modules' -g '!.git' -g '!docs' -g '!issues' -g '!pnpm-lock.yaml' -g '!scripts/' \
  "pi-tools" "$ROOT" 2>/dev/null || true)
if [ -n "${HITS:-}" ]; then
  bad "stale 'pi-tools/' path found: $HITS"
else
  ok "no 'pi-tools/' in code or reference docs"
fi

note "shipped settings.json points at the seven current Extension packages"
SET="$ROOT/packages/pi-config/settings.json"
MISSING=()
for name in "${EXPECTED[@]}"; do
  if ! grep -q "\"./packages/$name\"" "$SET"; then
    MISSING+=("$name")
  fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  bad "settings.json missing current paths for: ${MISSING[*]}"
else
  ok "settings.json references all seven current Extension package paths"
fi

note "pi-config is NOT listed as an Extension package (only as skills path)"
if grep -q '"./packages/pi-config"' "$SET"; then
  bad "settings.json still lists pi-config under packages/"
else
  ok "pi-config is not referenced as a package under packages/"
fi

heading "Root metadata tells the same story"
note "root package.json name/description match the seven-package model"
DESC=$(node -p "require('$ROOT/package.json').description")
case "$DESC" in
  *"shared"*) bad "root description still mentions 'shared': $DESC" ;;
  *) ok "root description: $DESC" ;;
esac
KW=$(node -p "JSON.stringify(require('$ROOT/package.json').keywords)")
case "$KW" in
  *pi-extension*) ok "root keywords include 'pi-extension'" ;;
  *) bad "root keywords missing 'pi-extension'" ;;
esac

note "root build/typecheck scripts filter the right packages"
for s in build:ext typecheck:ext; do
  CMD=$(node -p "require('$ROOT/package.json').scripts['$s'] || ''")
  case "$CMD" in
    *'@epr3/pi-extension-'*) ok "$s targets @epr3/pi-extension-*" ;;
    *) bad "$s does not target Extension package filter: $CMD" ;;
  esac
done

note "pnpm-workspace.yaml lists packages/*"
if grep -q '"packages/\*"' "$ROOT/pnpm-workspace.yaml"; then
  ok "workspace includes packages/*"
else
  bad "pnpm-workspace.yaml does not list packages/*"
fi

note "README uses 'Extension package' for runnable packages, lists exactly seven"
README="$ROOT/packages/README.md"
if ! grep -q "Extension package" "$README"; then
  bad "README does not use 'Extension package' vocabulary"
else
  ok "README uses 'Extension package' vocabulary"
fi
for name in "${EXPECTED[@]}"; do
  grep -q "\\b$name\\b" "$README" || bad "README does not mention $name"
done
[ $FAIL -eq 0 ] && ok "README lists all seven Extension packages"
if grep -q "shared/pi.ts" "$README" || grep -q "shared/\b" "$README"; then
  bad "README still references shared/ as architecture"
else
  ok "README does not present shared/ as architecture"
fi
if grep -q "pi-tools" "$README"; then
  bad "README still mentions pi-tools/"
else
  ok "README does not mention pi-tools/"
fi

heading "Unit-test infrastructure"
note "test files live alongside their source under __tests__/ or as *.test.ts in the package"
# Allowlist: each package that has tests is listed here so the audit knows about them.
# The test runner is Node built-in (node --test + tsx), not an external framework.
KNOWN_TESTS=(
  "packages/statusline/zone.test.ts"
  "packages/subagents/__tests__/agents.test.ts"
)
HITS=$(find "$ROOT/packages" -name '*.test.ts' -o -name '*.spec.ts' 2>/dev/null || true)
UNEXPECTED=""
while IFS= read -r f; do
  matched=0
  for known in "${KNOWN_TESTS[@]}"; do
    case "$f" in
      *"$known") matched=1 ;;  # suffix match so paths without the prefix still resolve
    esac
  done
  [ "$matched" -eq 0 ] && UNEXPECTED="$UNEXPECTED$f"$'\n'""
done <<< "$HITS"
if [ -n "$UNEXPECTED" ]; then
  bad "unexpected test files: $UNEXPECTED"
else
  ok "all test files are in the known allowlist"
fi

note "no external test framework dependency in any Extension package"
for name in "${EXPECTED[@]}"; do
  PJ="$ROOT/packages/$name/package.json"
  for framework in vitest jest mocha tap ava; do
    if grep -qi "\"$framework\"" "$PJ"; then
      bad "$name: declares test framework '$framework'"
    fi
  done
done
[ $FAIL -eq 0 ] && ok "no external test framework declared — uses node --test + tsx"

echo
if [ $FAIL -eq 0 ]; then
  printf "\033[1;32mExtension package audit: PASS\033[0m\n"
  exit 0
else
  printf "\033[1;31mExtension package audit: FAIL\033[0m\n"
  exit 1
fi
