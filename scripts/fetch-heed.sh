#!/usr/bin/env bash
#
# Fetch the bundled `heed` sidecar from GitHub Releases and place it at
# src-tauri/binaries/heed-<target-triple>, where Tauri's `externalBin` expects
# it. Run before `tauri build`. Idempotent: re-running re-downloads and replaces.
#
#   HEED_VERSION=0.1.0 ./scripts/fetch-heed.sh            # host triple
#   TARGET=aarch64-apple-darwin ./scripts/fetch-heed.sh   # explicit triple (CI)
#
set -euo pipefail

HEED_VERSION="${HEED_VERSION:-0.1.0}"
REPO="${HEED_REPO:-nibbletech-labs/heed}"
# Default to the host triple; CI passes TARGET to match `tauri build --target`.
TARGET="${TARGET:-$(rustc -vV | sed -n 's/host: //p')}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../src-tauri/binaries"
mkdir -p "$BIN_DIR"

ASSET="heed-${HEED_VERSION}-${TARGET}.tar.gz"
URL="https://github.com/${REPO}/releases/download/v${HEED_VERSION}/${ASSET}"
DEST="$BIN_DIR/heed-${TARGET}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching ${ASSET} ..."
curl -fsSL "$URL" -o "$TMP/$ASSET"
curl -fsSL "$URL.sha256" -o "$TMP/$ASSET.sha256"

# Checksum file is "<hash>  <asset>"; verify from within TMP so the name matches.
( cd "$TMP" && shasum -a 256 -c "$ASSET.sha256" )

tar -xzf "$TMP/$ASSET" -C "$TMP"
# Tarball layout (see heed release.yml): heed-<version>-<target>/heed
cp "$TMP/heed-${HEED_VERSION}-${TARGET}/heed" "$DEST"
chmod +x "$DEST"

echo "Placed sidecar at ${DEST}"
