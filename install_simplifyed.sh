#!/usr/bin/env bash
#
# Automated installer for Simplifyed Admin on a Debian/Ubuntu host.
# - Installs Node.js (LTS), git, nginx, certbot
# - Clones the repo (or uses an existing path if provided)
# - Prompts for domain, ports, OAuth config, test mode, and env values
# - Generates .env, systemd service, and nginx reverse-proxy config with TLS
#
# Run as root (or with sudo): bash install_simplifyed.sh
#

set -euo pipefail

REPO_URL="https://github.com/your-org/Simplifyed.git"
APP_NAME="simplifyed-admin"
APP_DIR="/opt/${APP_NAME}"
APP_PORT_DEFAULT=3000

log() { echo -e "[INFO] $*"; }
warn() { echo -e "[WARN] $*"; }
err() { echo -e "[ERR ] $*" >&2; }

prompt() {
  local var="$1" prompt_text="$2" default="${3-}"
  local value
  read -rp "$prompt_text ${default:+[$default]}: " value
  if [[ -z "$value" && -n "$default" ]]; then
    value="$default"
  fi
  printf "%s" "$value"
}

require_root() {
  if [[ $EUID -ne 0 ]]; then
    err "Please run as root (sudo)."
    exit 1
  fi
}

install_dependencies() {
  log "Updating apt and installing dependencies..."
  apt-get update -y
  apt-get install -y curl git nginx python3-certbot-nginx

  if ! command -v node >/dev/null 2>&1; then
    log "Installing Node.js LTS..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y nodejs
  fi
}

clone_repo() {
  if [[ -d "$APP_DIR/.git" ]]; then
    log "Repo already present at $APP_DIR, pulling latest..."
    git -C "$APP_DIR" pull
  else
    log "Cloning repository into $APP_DIR..."
    git clone "$REPO_URL" "$APP_DIR"
  fi
}

create_env_file() {
  local env_file="$APP_DIR/backend/.env"
  log "Creating .env at $env_file ..."

  cat > "$env_file" <<EOF
NODE_ENV=production
PORT=$APP_PORT
BASE_URL=https://$DOMAIN
ENABLE_TEST_MODE=$ENABLE_TEST_MODE
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL=$GOOGLE_CALLBACK_URL
SESSION_SECRET=$SESSION_SECRET
DATABASE_PATH=./database/simplifyed.db
EOF

  log ".env created."
}

create_systemd_service() {
  local service_file="/etc/systemd/system/${APP_NAME}.service"
  log "Creating systemd service at $service_file ..."

  cat > "$service_file" <<EOF
[Unit]
Description=Simplifyed Admin Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/backend
ExecStart=/usr/bin/node $APP_DIR/backend/server.js
Environment=NODE_ENV=production
EnvironmentFile=$APP_DIR/backend/.env
Restart=always
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${APP_NAME}.service"
  log "Systemd service enabled and started."
}

configure_nginx() {
  local nginx_conf="/etc/nginx/sites-available/${APP_NAME}.conf"
  log "Creating nginx config for $DOMAIN -> http://127.0.0.1:$APP_PORT ..."

  cat > "$nginx_conf" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  ln -sf "$nginx_conf" /etc/nginx/sites-enabled/${APP_NAME}.conf
  nginx -t && systemctl reload nginx

  if [[ "$ENABLE_HTTPS" == "y" ]]; then
    log "Obtaining Let's Encrypt certificate for $DOMAIN ..."
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"
  else
    warn "HTTPS not enabled. You can run: certbot --nginx -d $DOMAIN"
  fi
}

install_app() {
  pushd "$APP_DIR/backend" >/dev/null
  log "Installing npm dependencies..."
  npm install

  if npm run | grep -q build; then
    log "Building frontend assets..."
    npm run build || warn "Build step failed or not defined."
  fi

  popd >/dev/null
}

main() {
  require_root

  DOMAIN=$(prompt domain "Enter the primary domain (e.g., admin.simplifyed.in)")
  APP_PORT=$(prompt app_port "Enter app internal port" "$APP_PORT_DEFAULT")
  ENABLE_TEST_MODE=$(prompt test_mode "Enable test mode? (true/false)" "false")

  EMAIL=$(prompt email "Enter email for Let's Encrypt and notifications")
  ENABLE_HTTPS=$(prompt https "Enable HTTPS with Let's Encrypt? (y/n)" "y")

  if [[ "$ENABLE_TEST_MODE" == "true" ]]; then
    GOOGLE_CLIENT_ID=""
    GOOGLE_CLIENT_SECRET=""
    GOOGLE_CALLBACK_URL=""
    warn "Test mode enabled; OAuth credentials skipped."
  else
    GOOGLE_CLIENT_ID=$(prompt gcid "Enter Google OAuth Client ID")
    GOOGLE_CLIENT_SECRET=$(prompt gcsecret "Enter Google OAuth Client Secret")
    GOOGLE_CALLBACK_URL=$(prompt gcallback "Enter Google OAuth Callback URL" "https://$DOMAIN/auth/google/callback")
  fi

  SESSION_SECRET=$(prompt session "Enter a SESSION_SECRET (random string)")

  install_dependencies
  clone_repo
  install_app
  create_env_file
  create_systemd_service
  configure_nginx

  log "Installation complete. Visit https://$DOMAIN (or http://$DOMAIN if HTTPS disabled)."
}

main "$@"
