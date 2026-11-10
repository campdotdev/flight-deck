#!/bin/sh
# Builds one Flight Deck version folder from this checkout (spec 1, "Install", ADR 0015).
#
#   scripts/build-version.sh <out>
#
# It compiles the runner with Bun 1.4.3 for bun-darwin-arm64 and lays out <out> as a version folder: bin/,
# plugin/, skills/, data/, vendor/, LICENSE, and CREDITS.md. The version is package.json's version plus
# -dev.<UTC time> to the second, such as 0.1.0-dev.20261101T103012Z. The binary carries it as
# FLIGHT_DECK_VERSION, because install runs it from <out>/bin/ before it's copied into versions/, and
# plugin/.claude-plugin/plugin.json carries it too, so `flight-deck update --from <out>` can read it.
#
# Set BUN to Bun 1.4.3's path when the bun on PATH is another version. <out> must not exist or be empty. The
# folder appears only once the build is whole, so a failed build leaves nothing at <out>.
set -eu

PINNED_BUN=1.4.3
root=$(cd "$(dirname "$0")/.." && pwd)
bun=${BUN:-bun}

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/build-version.sh <out>" >&2
  exit 64
fi
out=$1

have=$("$bun" --version 2>/dev/null || true)
if [ "$have" != "$PINNED_BUN" ]; then
  echo "build-version.sh needs Bun $PINNED_BUN, and $bun is ${have:-missing}. Set BUN to Bun $PINNED_BUN's path." >&2
  exit 1
fi
if [ -e "$out" ] && { [ ! -d "$out" ] || [ -n "$(ls -A "$out")" ]; }; then
  echo "$out isn't empty. Name a new folder for the version." >&2
  exit 1
fi

# Runs a step quietly, and prints its output only when it fails.
quietly() {
  if ! log=$("$@" 2>&1); then
    printf '%s\n' "$log" >&2
    exit 1
  fi
}

base=$(FILE="$root/runner/package.json" "$bun" -e 'console.log(JSON.parse(await Bun.file(process.env.FILE).text()).version)')
stamp=$(date -u +%Y%m%dT%H%M%SZ)
version="$base-dev.$stamp"

# vendor/ ships as it is, so it has to be whole first: the pinned Betterleaks and sandbox-runtime's node_modules.
quietly "$root/scripts/fetch-betterleaks.sh"
quietly "$bun" install --frozen-lockfile --cwd "$root/runner"
quietly "$bun" install --frozen-lockfile --cwd "$root/vendor/sandbox-runtime"

parent=$(dirname "$out")
mkdir -p "$parent"
stage=$(mktemp -d "$parent/.flight-deck-build.XXXXXX")
trap 'rm -rf "$stage"' EXIT

quietly "$bun" build --compile --target=bun-darwin-arm64 --define "FLIGHT_DECK_VERSION=\"$version\"" \
  "$root/runner/src/cli/main.ts" --outfile "$stage/bin/flight-deck"
for folder in plugin skills data vendor; do
  rsync -a --exclude .DS_Store --exclude .gitignore "$root/$folder/" "$stage/$folder/"
done
cp "$root/LICENSE" "$root/CREDITS.md" "$stage/"
FILE="$stage/plugin/.claude-plugin/plugin.json" VERSION="$version" "$bun" -e '
  const file = Bun.file(process.env.FILE);
  const plugin = JSON.parse(await file.text());
  await Bun.write(file, `${JSON.stringify({ ...plugin, version: process.env.VERSION }, null, "\t")}\n`);
'
chmod 755 "$stage"

if [ -d "$out" ]; then rmdir "$out"; fi
mv "$stage" "$out"
trap - EXIT
# A build can take under a second. Ending only once the stamped second has passed means the next build on this
# Mac gets a later stamp, so two builds never share a version.
while [ "$(date -u +%Y%m%dT%H%M%SZ)" = "$stamp" ]; do sleep 0.2; done
echo "Built Flight Deck $version at $out"
