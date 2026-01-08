#!/bin/bash

# Simplifyed Admin - Update Script
# Usage:
#   sudo ./update.sh --instance dev
#   sudo ./update.sh --dir /opt/simplifyed
#
# Notes:
# - Expects an existing installation cloned via install.sh
# - Leaves .env and database intact; only pulls code and rebuilds

set -euo pipefail

INSTANCE=""
INSTALL_DIR=""
APP_USER=""
SERVICE_NAME=""
INSTALL_ROOT="/opt"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  echo "Usage: sudo $0 [--instance <name> | --dir <path>] [--source <path>]"
  echo "  --instance   Instance identifier used during install (e.g., prod, dev, staging)"
  echo "  --dir        Absolute install directory (e.g., /opt/simplifyed-dev)"
  echo "  --source     Path to the updated code (defaults to the directory containing this script)"
  echo "If neither is provided and /opt/simplifyed* dirs exist, you'll be prompted to choose."
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      INSTANCE="$2"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --source)
      SOURCE_DIR="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

# Auto-detect instances if none provided
if [[ -z "$INSTALL_DIR" && -z "$INSTANCE" ]]; then
  mapfile -t candidates < <(ls -d ${INSTALL_ROOT}/simplifyed* 2>/dev/null | sort)
  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "❌ No installations found under ${INSTALL_ROOT}/simplifyed*"
    usage
  fi
  echo "Select an installation to update:"
  select choice in "${candidates[@]}"; do
    if [[ -n "$choice" ]]; then
      INSTALL_DIR="$choice"
      break
    else
      echo "Invalid selection."
    fi
  done
fi

if [[ -n "$INSTANCE" ]]; then
  INSTALL_DIR="/opt/simplifyed-${INSTANCE}"
  APP_USER="simplifyed-${INSTANCE}"
  SERVICE_NAME="simplifyed-${INSTANCE}"
else
  base="$(basename "$INSTALL_DIR")"
  if [[ "$base" == "simplifyed" ]]; then
    APP_USER="simplifyed"
    SERVICE_NAME="simplifyed"
  elif [[ "$base" == simplifyed-* ]]; then
    APP_USER="$base"
    SERVICE_NAME="$base"
  else
    APP_USER="$base"
    SERVICE_NAME="$base"
  fi
fi

# Validate source dir looks like app root
if [[ ! -f "$SOURCE_DIR/backend/package.json" ]]; then
  echo "❌ Source directory does not look like Simplifyed repo: $SOURCE_DIR"
  echo "    Expected: $SOURCE_DIR/backend/package.json"
  exit 1
fi

# Ensure install dir exists
if [[ ! -d "$INSTALL_DIR" ]]; then
  echo "❌ Install dir not found: $INSTALL_DIR"
  exit 1
fi

cd "$INSTALL_DIR"

echo "============================================================"
echo " Updating Simplifyed Admin"
echo "------------------------------------------------------------"
echo "  Install dir : $INSTALL_DIR"
echo "  Source dir  : $SOURCE_DIR"
echo "  Service     : $SERVICE_NAME"
echo "  App user    : $APP_USER"
echo "============================================================"

echo "➜ Stopping service..."
systemctl stop "$SERVICE_NAME"

echo "➜ Syncing updated code from source..."
rsync -av \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='backend/node_modules' \
  --exclude='backend/database' \
  --exclude='backend/logs' \
  --exclude='*.log' \
  "$SOURCE_DIR/" "$INSTALL_DIR/"

# Ensure writable dirs (db/logs/public assets) belong to app user
chown -R "$APP_USER":"$APP_USER" \
  "$INSTALL_DIR/backend/database" \
  "$INSTALL_DIR/backend/logs" \
  "$INSTALL_DIR/backend/data" \
  "$INSTALL_DIR/backend/public"

# Ensure package-lock and workspace files are writable by app user
chown "$APP_USER":"$APP_USER" \
  "$INSTALL_DIR/backend/package-lock.json" \
  "$INSTALL_DIR/backend/package.json" \
  "$INSTALL_DIR/backend"

# Check .env vs .env.example for new keys
ENV_FILE="$INSTALL_DIR/backend/.env"
ENV_EXAMPLE="$INSTALL_DIR/backend/.env.example"
if [[ -f "$ENV_FILE" && -f "$ENV_EXAMPLE" ]]; then
  echo "➜ Checking .env for new keys..."
  missing_keys=$(comm -13 <(grep -o '^[A-Za-z0-9_]\+=' "$ENV_FILE" | sed 's/=.*//' | sort -u) \
                        <(grep -o '^[A-Za-z0-9_]\+=' "$ENV_EXAMPLE" | sed 's/=.*//' | sort -u))
  if [[ -n "$missing_keys" ]]; then
    optional_env_keys=(
      OPENALGO_TARGETS
      TRADINGVIEW_BROADCAST_DEFAULT_RPS
      TRADINGVIEW_BROADCAST_RETRIES
      TRADINGVIEW_BROADCAST_RETRY_DELAY_MS
      TRADINGVIEW_BROADCAST_TIMEOUT_MS
      WEBHOOK_TOKEN
      WS_GATEWAY_ENABLED
      WS_GATEWAY_PATH
    )
    optional_regex="$(printf "|%s" "${optional_env_keys[@]}")"
    optional_regex="${optional_regex#|}"
    missing_required_keys=$(echo "$missing_keys" | grep -v -E "^(${optional_regex})$" || true)
    if [[ -n "$missing_required_keys" ]]; then
      echo "⚠️  The following required keys are in .env.example but missing from your .env:"
      echo "$missing_required_keys"
      echo "    Please open $ENV_FILE and add any required values before restarting if needed."
    else
      echo "ℹ Only optional keys are missing from .env:"
      echo "$missing_keys"
      echo "  You can ignore these unless you use TradingView broadcast or WS gateway."
    fi
  else
    echo "✓ .env is up to date with .env.example keys."
  fi
else
  echo "ℹ Skipping .env check (missing .env or .env.example)."
fi

echo "➜ Installing dependencies..."
cd "$INSTALL_DIR/backend"
sudo -u "$APP_USER" npm ci --quiet

echo "➜ Building CSS..."
sudo -u "$APP_USER" npm run build:css --silent

echo "➜ Pruning dev dependencies..."
sudo -u "$APP_USER" npm prune --production --quiet

echo "➜ Running migrations..."
sudo -u "$APP_USER" npm run migrate --silent

echo "➜ Restarting service..."
systemctl restart "$SERVICE_NAME"

echo "➜ Service status:"
systemctl status "$SERVICE_NAME" --no-pager | sed -n '1,5p'

echo "➜ Recent logs:"
journalctl -u "$SERVICE_NAME" -n 20 --no-pager

echo "✅ Update complete."
