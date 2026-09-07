#!/usr/bin/env bash
#
# Fetch the notarized `Heed.app` bundle from GitHub Releases and place it at
# src-tauri/resources/Heed.app, where tauri.conf.json's `bundle.macOS.files`
# picks it up (it ships as Codezilla.app/Contents/Resources/Heed.app). Run
# before `tauri build`. Idempotent: re-running re-downloads and replaces.
#
#   HEED_VERSION=0.3.1 ./scripts/fetch-heed.sh            # host triple
#   TARGET=aarch64-apple-darwin ./scripts/fetch-heed.sh   # explicit triple (CI)
#
set -euo pipefail

HEED_VERSION="${HEED_VERSION:-0.3.1}"
REPO="${HEED_REPO:-nibbletech-labs/heed}"
# Override to a local `file://` directory to test the checksum path offline.
BASE_URL="${HEED_BASE_URL:-https://github.com/${REPO}/releases/download/v${HEED_VERSION}}"
# Default to the host triple; CI passes TARGET to match `tauri build --target`.
TARGET="${TARGET:-$(rustc -vV | sed -n 's/host: //p')}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RES_DIR="$SCRIPT_DIR/../src-tauri/resources"
mkdir -p "$RES_DIR"

ASSET="Heed-${HEED_VERSION}-${TARGET}.app.zip"
DEST="$RES_DIR/Heed.app"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching ${ASSET} ..."
curl -fsSL "${BASE_URL}/${ASSET}" -o "$TMP/$ASSET"
curl -fsSL "${BASE_URL}/${ASSET}.sha256" -o "$TMP/$ASSET.sha256"

# Checksum file is "<hash>  <asset>"; verify from within TMP so the name matches.
( cd "$TMP" && shasum -a 256 -c "$ASSET.sha256" )

# The zip was made with `ditto -c -k --keepParent`, so it unpacks to Heed.app/.
# ditto preserves the code signature, symlinks and permissions exactly.
mkdir "$TMP/unpacked"
ditto -x -k "$TMP/$ASSET" "$TMP/unpacked"
if [ ! -x "$TMP/unpacked/Heed.app/Contents/MacOS/heed" ]; then
  echo "error: ${ASSET} did not contain Heed.app/Contents/MacOS/heed" >&2
  exit 1
fi

# Swap into place so a failed run never leaves a half-replaced bundle behind.
rm -rf "$DEST.staging" "$DEST.old"
mv "$TMP/unpacked/Heed.app" "$DEST.staging"
if [ -d "$DEST" ]; then mv "$DEST" "$DEST.old"; fi
mv "$DEST.staging" "$DEST"
rm -rf "$DEST.old"

echo "Placed Heed.app at ${DEST}"
