#!/bin/sh
# Puts the pinned Betterleaks at vendor/betterleaks, the binary the Outbox's secret scan runs (spec 1, "The
# secret scan", ADR 0007). It downloads the darwin-arm64 release from GitHub and checks the tarball's and the
# binary's sha256 against the pins below. A binary already in place that matches its pin is kept, so a second
# run needs no network. CI and a local checkout both run this before the tests.
set -eu

VERSION=1.9.0
TARBALL_SHA256=83dd7eaab13d44a1e8e347a17064cdef153a1478db473276d41b38d55613d3f2
BINARY_SHA256=70d2103c2915aababa0e1eea121bd3db0ff0da86bee40ddc6f5982181acaf6d0
URL="https://github.com/betterleaks/betterleaks/releases/download/v${VERSION}/betterleaks_${VERSION}_darwin_arm64.tar.gz"

root=$(cd "$(dirname "$0")/.." && pwd)
target="$root/vendor/betterleaks"

sha256() {
  shasum -a 256 "$1" | cut -d' ' -f1
}

if [ -f "$target" ] && [ "$(sha256 "$target")" = "$BINARY_SHA256" ]; then
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 -o "$work/betterleaks.tar.gz" "$URL"
got=$(sha256 "$work/betterleaks.tar.gz")
if [ "$got" != "$TARBALL_SHA256" ]; then
  echo "betterleaks ${VERSION}: the tarball's sha256 is $got, not $TARBALL_SHA256" >&2
  exit 1
fi
mkdir "$work/x"
tar -xzf "$work/betterleaks.tar.gz" -C "$work/x" betterleaks
got=$(sha256 "$work/x/betterleaks")
if [ "$got" != "$BINARY_SHA256" ]; then
  echo "betterleaks ${VERSION}: the binary's sha256 is $got, not $BINARY_SHA256" >&2
  exit 1
fi
chmod 755 "$work/x/betterleaks"
mv "$work/x/betterleaks" "$target"
echo "Put Betterleaks ${VERSION} at vendor/betterleaks."
