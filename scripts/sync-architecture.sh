#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SRC="$ROOT/ARCHITECTURE.md"
DST_DIR="$ROOT/.agent"
DST="$DST_DIR/ARCHITECTURE.md"

if [ ! -f "$SRC" ]; then
  echo "sync-architecture: source not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DST_DIR"
cp -f "$SRC" "$DST"

git add "$DST" >/dev/null 2>&1 || true
