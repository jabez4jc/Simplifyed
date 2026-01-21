#!/bin/bash

# Simplifyed Admin - Uninstall Instance Script
# Usage:
#   sudo ./uninstall-instance.sh --instance dev
#   sudo ./uninstall-instance.sh --dir /opt/simplifyed-dev

set -euo pipefail

INSTANCE=""
INSTALL_DIR=""
SERVICE_NAME=""
APP_USER=""
NGINX_SITE=""
FORCE=false
INSTALL_ROOT="/opt"

usage() {
  echo "Usage: sudo $0 [--instance <name> | --dir <path>] [--force]"
  echo "  --instance   Instance identifier used during install (e.g., prod, dev, staging)"
  echo "  --dir        Absolute install directory (e.g., /opt/simplifyed-dev)"
  echo "  --force      Skip confirmation prompts"
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
    --force|--yes)
      FORCE=true
      shift 1
      ;;
    *)
      usage
      ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "❌ This script must be run as root or with sudo"
  exit 1
fi

# Auto-detect instances if none provided
if [[ -z "$INSTALL_DIR" && -z "$INSTANCE" ]]; then
  mapfile -t candidates < <(ls -d ${INSTALL_ROOT}/simplifyed* 2>/dev/null | sort)
  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "❌ No installations found under ${INSTALL_ROOT}/simplifyed*"
    usage
  fi
  echo "Select an installation to uninstall:"
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
  NGINX_SITE="simplifyed-${INSTANCE}"
else
  base="$(basename "$INSTALL_DIR")"
  if [[ "$base" == "simplifyed" ]]; then
    APP_USER="simplifyed"
    SERVICE_NAME="simplifyed"
    NGINX_SITE="simplifyed"
  else
    APP_USER="$base"
    SERVICE_NAME="$base"
    NGINX_SITE="$base"
  fi
fi

# Safety checks for install dir
if [[ -z "$INSTALL_DIR" || "$INSTALL_DIR" == "/" || "$INSTALL_DIR" == "/opt" ]]; then
  echo "❌ Refusing to remove unsafe install dir: '$INSTALL_DIR'"
  exit 1
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
  echo "❌ Install dir not found: $INSTALL_DIR"
  exit 1
fi

echo "============================================================"
echo " Uninstalling Simplifyed Instance"
echo "------------------------------------------------------------"
echo "  Install dir : $INSTALL_DIR"
echo "  Service     : $SERVICE_NAME"
echo "  App user    : $APP_USER"
echo "  Nginx site  : $NGINX_SITE"
echo "============================================================"

if [[ "$FORCE" == false ]]; then
  read -r -p "This will permanently remove the instance. Continue? (y/N): " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# Stop and disable systemd service
if systemctl list-unit-files --type=service | grep -q "^${SERVICE_NAME}\.service"; then
  echo "➜ Stopping service..."
  systemctl stop "$SERVICE_NAME" || true
  echo "➜ Disabling service..."
  systemctl disable "$SERVICE_NAME" || true
  echo "➜ Removing systemd unit file..."
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
else
  echo "ℹ Service not found: ${SERVICE_NAME}.service"
fi

# Remove Nginx config
DOMAINS=()
if [[ -f "/etc/nginx/sites-available/${NGINX_SITE}" ]]; then
  while read -r domain; do
    [[ -n "$domain" ]] && DOMAINS+=("$domain")
  done < <(awk '/server_name/ { for (i=2; i<=NF; i++) { gsub(";", "", $i); print $i } }' "/etc/nginx/sites-available/${NGINX_SITE}" | sort -u)
fi

if [[ -f "/etc/nginx/sites-enabled/${NGINX_SITE}" ]]; then
  echo "➜ Removing Nginx site enablement..."
  rm -f "/etc/nginx/sites-enabled/${NGINX_SITE}"
fi
if [[ -f "/etc/nginx/sites-available/${NGINX_SITE}" ]]; then
  echo "➜ Removing Nginx site config..."
  rm -f "/etc/nginx/sites-available/${NGINX_SITE}"
fi

if command -v nginx >/dev/null 2>&1; then
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
  else
    echo "⚠️  Nginx config test failed. Skipping reload."
    nginx -t || true
  fi
else
  echo "ℹ Nginx not installed; skipping reload."
fi

# Remove SSL certs (optional)

if [[ ${#DOMAINS[@]} -gt 0 ]]; then
  if [[ "$FORCE" == true ]]; then
    remove_certs=true
  else
    echo "Found domain(s) for cert cleanup: ${DOMAINS[*]}"
    read -r -p "Remove matching certbot certs? (y/N): " cert_confirm
    remove_certs=false
    if [[ "$cert_confirm" =~ ^[Yy]$ ]]; then
      remove_certs=true
    fi
  fi
  if [[ "$remove_certs" == true ]]; then
    if command -v certbot >/dev/null 2>&1; then
      for domain in "${DOMAINS[@]}"; do
        echo "➜ Removing cert for ${domain}..."
        certbot delete --cert-name "$domain" --non-interactive || true
      done
    else
      echo "ℹ certbot not installed; skipping certificate removal."
    fi
  fi
fi

# Remove application files
echo "➜ Removing application directory..."
rm -rf "$INSTALL_DIR"

# Remove app user
if id "$APP_USER" >/dev/null 2>&1; then
  echo "➜ Removing user ${APP_USER}..."
  userdel -r "$APP_USER" || true
fi

# Remove nginx logs (best-effort)
rm -f "/var/log/nginx/${NGINX_SITE}"* 2>/dev/null || true

echo "✅ Instance removed successfully."
