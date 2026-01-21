#!/bin/bash

################################################################################
# Simplifyed Admin - Automated Installation Script for Ubuntu
################################################################################
# This script automates the installation of Simplifyed Admin on Ubuntu servers
# with Nginx reverse proxy and Let's Encrypt SSL certificates.
#
# Usage: sudo bash install.sh
#
# Prerequisites:
#   - Ubuntu 20.04 or later
#   - Root or sudo access
#   - A domain name pointing to this server's IP address
################################################################################

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Global variables
INSTANCE_NAME=""  # Will be set during user input (e.g., "prod", "staging", "dev")
INSTALL_DIR="/opt/simplifyed"
APP_USER="simplifyed"
NODE_VERSION="20"
DOMAIN=""
EMAIL=""
PORT=3000
ADMIN_EMAIL=""

################################################################################
# Helper Functions
################################################################################

print_header() {
    echo ""
    echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        print_error "This script must be run as root or with sudo"
        exit 1
    fi
}

# Check Ubuntu version
check_ubuntu() {
    if ! grep -q "Ubuntu" /etc/os-release; then
        print_error "This script is designed for Ubuntu. Detected: $(cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
        exit 1
    fi

    version=$(lsb_release -rs)
    if (( $(echo "$version < 20.04" | bc -l) )); then
        print_warning "Ubuntu version $version detected. Ubuntu 20.04 or later is recommended."
        read -p "Continue anyway? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi

    print_success "Ubuntu $(lsb_release -rs) detected"
}

# Generate random string
generate_random_string() {
    openssl rand -base64 48 | tr -d "=+/" | cut -c1-64
}

################################################################################
# User Input Collection
################################################################################

collect_user_input() {
    print_header "Configuration Setup"

    # Instance identifier (for multi-instance support)
    echo ""
    print_info "Instance Identifier (optional - for multiple installations)"
    echo "  Examples: 'prod', 'staging', 'dev', or leave empty for single instance"
    echo "  This creates unique names for directory, user, and service"
    read -p "Enter instance identifier (or press Enter to skip): " INSTANCE_NAME

    # Set defaults based on instance name
    if [[ -n "$INSTANCE_NAME" ]]; then
        # Validate instance name (alphanumeric and hyphens only)
        if [[ ! "$INSTANCE_NAME" =~ ^[a-zA-Z0-9-]+$ ]]; then
            print_error "Instance name must contain only letters, numbers, and hyphens"
            exit 1
        fi

        INSTALL_DIR="/opt/simplifyed-${INSTANCE_NAME}"
        APP_USER="simplifyed-${INSTANCE_NAME}"
        print_info "Using instance-specific defaults:"
        echo "  - Installation directory: $INSTALL_DIR"
        echo "  - System user: $APP_USER"
        echo "  - Service name: simplifyed-${INSTANCE_NAME}"
    else
        INSTALL_DIR="/opt/simplifyed"
        APP_USER="simplifyed"
        print_info "Using single-instance defaults"
    fi
    echo ""

    # Domain name
    while [[ -z "$DOMAIN" ]]; do
        read -p "Enter your domain name (e.g., admin.example.com): " DOMAIN
        if [[ -z "$DOMAIN" ]]; then
            print_error "Domain name cannot be empty"
        fi
    done

    # Email for Let's Encrypt
    while [[ -z "$EMAIL" ]]; do
        read -p "Enter your email address (for Let's Encrypt notifications): " EMAIL
        if [[ -z "$EMAIL" ]]; then
            print_error "Email address cannot be empty"
        fi
    done

    # Application port
    if [[ -n "$INSTANCE_NAME" ]]; then
        echo ""
        print_info "Suggested ports: prod=3000, staging=3001, dev=3002"
    fi
    read -p "Enter application port (default: 3000): " PORT_INPUT
    if [[ -n "$PORT_INPUT" ]]; then
        PORT=$PORT_INPUT
    fi

    # Admin email for first login
    while [[ -z "$ADMIN_EMAIL" ]]; do
        read -p "Enter admin user email (first login will be granted Admin): " ADMIN_EMAIL
        if [[ -z "$ADMIN_EMAIL" ]]; then
            print_error "Admin email cannot be empty"
        fi
    done

    # Allow override of installation directory
    read -p "Installation directory (default: $INSTALL_DIR): " INSTALL_DIR_INPUT
    if [[ -n "$INSTALL_DIR_INPUT" ]]; then
        INSTALL_DIR=$INSTALL_DIR_INPUT
    fi

    print_success "Configuration collected successfully"
    echo ""
    print_info "Installation Summary:"
    if [[ -n "$INSTANCE_NAME" ]]; then
        echo "  Instance: $INSTANCE_NAME"
    fi
    echo "  Domain: $DOMAIN"
    echo "  Port: $PORT"
    echo "  Admin Email: $ADMIN_EMAIL"
    echo "  Install Dir: $INSTALL_DIR"
    echo "  User: $APP_USER"
    if [[ -n "$INSTANCE_NAME" ]]; then
        echo "  Service: simplifyed-${INSTANCE_NAME}"
    else
        echo "  Service: simplifyed"
    fi
    echo ""
    read -p "Press Enter to continue or Ctrl+C to cancel..."
}

################################################################################
# System Package Installation
################################################################################

install_system_packages() {
    print_header "Installing System Packages"

    print_info "Updating package list..."
    apt-get update -qq

    print_info "Installing required packages..."
    apt-get install -y -qq \
        curl \
        wget \
        git \
        build-essential \
        python3 \
        python3-dev \
        python3-setuptools \
        sqlite3 \
        nginx \
        certbot \
        python3-certbot-nginx \
        ufw \
        bc \
        rsync \
        dnsutils \
        software-properties-common

    distutils_policy="$(apt-cache policy python3-distutils 2>/dev/null || true)"
    if echo "$distutils_policy" | grep -q "Candidate:"; then
        if echo "$distutils_policy" | grep -q "Candidate: (none)"; then
            print_info "python3-distutils not available on this Ubuntu release; skipping"
        else
            apt-get install -y -qq python3-distutils
        fi
    else
        print_info "python3-distutils not available in apt sources; skipping"
    fi

    print_success "System packages installed"
}

################################################################################
# Node.js Installation
################################################################################

install_nodejs() {
    print_header "Installing Node.js ${NODE_VERSION}.x"

    if command -v node &> /dev/null; then
        current_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ $current_version -ge $NODE_VERSION ]]; then
            print_success "Node.js $(node -v) is already installed"
            return
        fi
    fi

    print_info "Adding NodeSource repository..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -

    print_info "Installing Node.js..."
    apt-get install -y -qq nodejs

    print_success "Node.js $(node -v) installed successfully"
    print_success "npm $(npm -v) installed successfully"
}

################################################################################
# User Creation
################################################################################

create_app_user() {
    print_header "Creating Application User"

    if id "$APP_USER" &>/dev/null; then
        print_warning "User '$APP_USER' already exists"
    else
        useradd -r -m -s /bin/bash $APP_USER
        print_success "User '$APP_USER' created"
    fi
}

################################################################################
# Application Installation
################################################################################

install_application() {
    print_header "Installing Simplifyed Application"

    # Create installation directory
    mkdir -p "$INSTALL_DIR"

    # Copy application files
    print_info "Copying application files to $INSTALL_DIR..."

    # Get the directory where the script is located
    SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

    # Copy all files except node_modules, .git, and database
    rsync -av --exclude='node_modules' \
              --exclude='.git' \
              --exclude='backend/database' \
              --exclude='backend/logs' \
              --exclude='*.log' \
              "$SCRIPT_DIR/" "$INSTALL_DIR/"

    # Create necessary directories
    mkdir -p "$INSTALL_DIR/backend/database"
    mkdir -p "$INSTALL_DIR/backend/logs"
    mkdir -p "$INSTALL_DIR/backend/data"

    # Set ownership (ensure SQLite, logs, and session dirs are writable)
    chown -R $APP_USER:$APP_USER "$INSTALL_DIR/backend/database" "$INSTALL_DIR/backend/logs" "$INSTALL_DIR/backend/data"
    chown -R $APP_USER:$APP_USER "$INSTALL_DIR"

    print_success "Application files copied"
}

################################################################################
# Environment Configuration
################################################################################

configure_environment() {
    print_header "Configuring Environment Variables"

    # Generate session secret
    SESSION_SECRET=$(generate_random_string)

    # Collect Supabase credentials (required)
    echo ""
    print_info "Supabase Auth Configuration (required)"
    while [[ -z "$SUPABASE_URL" ]]; do
        read -p "Supabase Project URL (e.g., https://xyz.supabase.co): " SUPABASE_URL
        if [[ -z "$SUPABASE_URL" ]]; then
            print_error "Supabase URL cannot be empty"
        fi
    done
    while [[ -z "$SUPABASE_ANON_KEY" ]]; do
        read -p "Supabase anon key: " SUPABASE_ANON_KEY
        if [[ -z "$SUPABASE_ANON_KEY" ]]; then
            print_error "Supabase anon key cannot be empty"
        fi
    done
    while [[ -z "$SUPABASE_JWT_SECRET" ]]; do
        read -p "Supabase JWT secret: " SUPABASE_JWT_SECRET
        if [[ -z "$SUPABASE_JWT_SECRET" ]]; then
            print_error "Supabase JWT secret cannot be empty"
        fi
    done

    # Collect Telegram credentials (optional)
    echo ""
    print_info "Telegram Bot Configuration (optional - press Enter to skip)"
    read -p "Telegram Bot Token: " TELEGRAM_BOT_TOKEN
    read -p "Telegram Bot Username: " TELEGRAM_BOT_USERNAME

    # Create .env file
    cat > "$INSTALL_DIR/backend/.env" <<EOF
# Server Configuration
NODE_ENV=production
PORT=$PORT
BASE_URL=https://$DOMAIN

# Database
DATABASE_PATH=./database/simplifyed.db

# Session
SESSION_SECRET=$SESSION_SECRET

# Supabase Auth (managed identity)
SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET
SUPABASE_JWT_AUD=authenticated
SUPABASE_JWT_ISS=$SUPABASE_URL

# Test Mode (disabled in production)
TEST_MODE=false
TEST_USER_EMAIL=admin@${DOMAIN}

# Polling Configuration
INSTANCE_POLL_INTERVAL_MS=15000
MARKET_DATA_POLL_INTERVAL_MS=5000

# OpenAlgo Configuration
OPENALGO_REQUEST_TIMEOUT_MS=15000
OPENALGO_CRITICAL_MAX_RETRIES=3
OPENALGO_CRITICAL_RETRY_DELAY_MS=500
OPENALGO_NONCRITICAL_MAX_RETRIES=1
OPENALGO_NONCRITICAL_RETRY_DELAY_MS=2000

# Logging
LOG_LEVEL=info
LOG_FILE=./logs/app.log

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_BOT_USERNAME=${TELEGRAM_BOT_USERNAME:-simplifyed_bot}
TELEGRAM_DEFAULT_CHAT_ID=

# Log Notifications
LOG_NOTIFICATIONS=true
EOF

    chown $APP_USER:$APP_USER "$INSTALL_DIR/backend/.env"
    chmod 600 "$INSTALL_DIR/backend/.env"

    print_success "Environment file created at $INSTALL_DIR/backend/.env"
}

################################################################################
# NPM Dependencies Installation
################################################################################

install_dependencies() {
    print_header "Installing NPM Dependencies"

    cd "$INSTALL_DIR/backend"

    print_info "Installing all dependencies (including build tools) with npm ci..."
    sudo -u $APP_USER npm ci --quiet

    print_success "Dependencies installed"
}

################################################################################
# Build Application
################################################################################

build_application() {
    print_header "Building Application"

    cd "$INSTALL_DIR/backend"

    print_info "Building CSS..."
    sudo -u $APP_USER npm run build:css

    print_info "Removing development dependencies..."
    sudo -u $APP_USER npm prune --production --quiet

    print_success "Application built successfully"
}

################################################################################
# Database Setup
################################################################################

setup_database() {
    print_header "Setting up Database"

    cd "$INSTALL_DIR/backend"

    DB_PATH="$INSTALL_DIR/backend/database/simplifyed.db"
    if [[ -f "$DB_PATH" ]]; then
        existing_table=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations';" 2>/dev/null || true)
        if [[ -n "$existing_table" ]]; then
            version_type=$(sqlite3 "$DB_PATH" "SELECT type FROM pragma_table_info('schema_migrations') WHERE name='version';" 2>/dev/null || true)
            if [[ "$version_type" != "TEXT" ]]; then
                print_info "Normalizing schema_migrations.version to TEXT..."
                sqlite3 "$DB_PATH" <<'SQL'
BEGIN;
CREATE TABLE schema_migrations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO schema_migrations_new (id, version, name, applied_at)
SELECT id, printf('%03d', version), name, applied_at FROM schema_migrations;
DROP TABLE schema_migrations;
ALTER TABLE schema_migrations_new RENAME TO schema_migrations;
COMMIT;
SQL
            else
                sqlite3 "$DB_PATH" \
                  "UPDATE schema_migrations SET version = printf('%03d', version) WHERE version GLOB '[0-9]*' AND length(version) < 3;" || true
            fi
        fi
    fi

    print_info "Running database migrations..."
    sudo -u $APP_USER npm run migrate

    print_info "Updating application settings (server.port)..."
    sqlite3 "$DB_PATH" \
      "UPDATE application_settings SET value='${PORT}' WHERE key='server.port';"

    print_info "Granting admin role to ${ADMIN_EMAIL}..."
    sqlite3 "$DB_PATH" <<SQL
INSERT OR IGNORE INTO users (email, is_admin) VALUES ('${ADMIN_EMAIL}', 1);
UPDATE users SET is_admin = 1 WHERE email = '${ADMIN_EMAIL}';
INSERT OR REPLACE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = '${ADMIN_EMAIL}' AND r.name = 'Admin';
SQL

    print_success "Database initialized and migrations applied"
}

################################################################################
# Systemd Service Configuration
################################################################################

create_systemd_service() {
    print_header "Creating Systemd Service"

    # Determine service name based on instance
    if [[ -n "$INSTANCE_NAME" ]]; then
        SERVICE_NAME="simplifyed-${INSTANCE_NAME}"
        SERVICE_DESC="Simplifyed Admin - Trading Dashboard ($INSTANCE_NAME)"
    else
        SERVICE_NAME="simplifyed"
        SERVICE_DESC="Simplifyed Admin - Trading Dashboard"
    fi

    NODE_BIN="$(command -v node || which node || echo /usr/bin/env node)"

    cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=$SERVICE_DESC
Documentation=https://github.com/jabez4jc/simplifyed
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$INSTALL_DIR/backend
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=BASE_URL=https://$DOMAIN
EnvironmentFile=$INSTALL_DIR/backend/.env
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=$SERVICE_NAME

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/backend/database $INSTALL_DIR/backend/logs $INSTALL_DIR/backend/data

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable ${SERVICE_NAME}.service

    print_success "Systemd service '${SERVICE_NAME}' created and enabled"
}

################################################################################
# Nginx Configuration
################################################################################

configure_nginx() {
    print_header "Configuring Nginx"

    # Check if Nginx is managing other sites
    existing_sites=$(ls /etc/nginx/sites-enabled/ 2>/dev/null | grep -v default | wc -l)
    if [ $existing_sites -gt 0 ]; then
        print_info "Detected $existing_sites existing Nginx site(s)"
        print_info "Adding Simplifyed site to existing Nginx configuration"
        # Only remove default if there are other sites (it's not being used)
        if [ -f /etc/nginx/sites-enabled/default ]; then
            print_info "Removing default Nginx site (not needed with custom sites)"
            rm -f /etc/nginx/sites-enabled/default
        fi
    else
        print_info "Configuring Nginx for first site"
        # Remove default site only if this is the first custom site
        rm -f /etc/nginx/sites-enabled/default
    fi

    # Determine Nginx site name based on instance
    if [[ -n "$INSTANCE_NAME" ]]; then
        NGINX_SITE="simplifyed-${INSTANCE_NAME}"
    else
        NGINX_SITE="simplifyed"
    fi

    # Create initial HTTP-only Nginx configuration (SSL will be added by certbot)
    cat > /etc/nginx/sites-available/${NGINX_SITE} <<EOF
# HTTP server - will be modified by certbot to add HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # Allow Let's Encrypt challenges
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Proxy to application
    location / {
        proxy_pass http://localhost:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # WebSocket support
        proxy_read_timeout 86400;
    }
}
EOF

    ln -sf /etc/nginx/sites-available/${NGINX_SITE} /etc/nginx/sites-enabled/

    # Test and reload Nginx with HTTP-only config
    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        print_success "Nginx HTTP configuration enabled"
    else
        print_warning "Nginx configuration test failed"
        nginx -t
    fi
}

################################################################################
# SSL Certificate Installation
################################################################################

install_ssl_certificate() {
    print_header "Installing Let's Encrypt SSL Certificate"

    # At this point, Nginx is running with HTTP-only config
    # We'll use certbot --nginx which will modify the config to add HTTPS

    print_info "Obtaining SSL certificate and configuring HTTPS for $DOMAIN..."
    print_info "Certbot will automatically update the Nginx configuration"

    # Use certbot --nginx to get certificate and configure HTTPS
    # This modifies the HTTP-only config to add HTTPS server block
    certbot --nginx \
        --non-interactive \
        --agree-tos \
        --email "$EMAIL" \
        -d "$DOMAIN" \
        --redirect

    if [ $? -eq 0 ]; then
        print_success "SSL certificate obtained and HTTPS configured successfully"
    else
        print_error "Failed to obtain SSL certificate"
        print_warning "Certbot encountered an error. You can try manually with:"
        print_warning "  certbot --nginx -d $DOMAIN"
        print_warning "The site is still accessible via HTTP at: http://$DOMAIN"
    fi

    # Set up auto-renewal
    systemctl enable certbot.timer
    systemctl start certbot.timer

    print_success "SSL certificate auto-renewal configured"
}

################################################################################
# Firewall Configuration
################################################################################

configure_firewall() {
    print_header "Configuring Firewall"

    print_info "Setting up UFW firewall rules..."

    # Check if UFW is already active
    if ufw status | grep -q "Status: active"; then
        print_warning "UFW firewall is already active with existing rules"
        print_info "Adding required rules without resetting existing configuration..."
    else
        print_info "Configuring UFW with default policies..."
        # Only reset if UFW is not active (fresh installation)
        ufw --force reset
        # Default policies
        ufw default deny incoming
        ufw default allow outgoing
    fi

    # Allow SSH (if not already allowed)
    print_info "Allowing SSH access..."
    ufw allow ssh

    # Allow HTTP and HTTPS
    print_info "Allowing HTTP and HTTPS traffic..."
    ufw allow 80/tcp
    ufw allow 443/tcp

    # Enable firewall
    ufw --force enable

    print_success "Firewall configured and enabled"
}

################################################################################
# Post-Installation Tasks
################################################################################

post_installation() {
    print_header "Completing Installation"

    # Determine service name based on instance
    if [[ -n "$INSTANCE_NAME" ]]; then
        SERVICE_NAME="simplifyed-${INSTANCE_NAME}"
    else
        SERVICE_NAME="simplifyed"
    fi

    # Start services
    print_info "Reloading Nginx configuration..."
    # Use reload instead of restart for graceful config reload
    # This ensures zero downtime for existing sites
    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        print_success "Nginx configuration reloaded successfully"
    else
        print_warning "Nginx configuration test failed, attempting restart..."
        systemctl restart nginx
    fi

    print_info "Starting Simplifyed application..."
    systemctl start ${SERVICE_NAME}

    # Wait a moment for the service to start
    sleep 3

    # Check service status
    if systemctl is-active --quiet ${SERVICE_NAME}; then
        print_success "Simplifyed service '${SERVICE_NAME}' is running"
    else
        print_error "Simplifyed service '${SERVICE_NAME}' failed to start"
        print_info "Check logs with: journalctl -u ${SERVICE_NAME} -n 50"
    fi

    if systemctl is-active --quiet nginx; then
        print_success "Nginx is running"
        # Check if Simplifyed site is accessible
        existing_sites=$(ls /etc/nginx/sites-enabled/ 2>/dev/null | grep -v default | wc -l)
        if [ $existing_sites -gt 1 ]; then
            print_info "Multiple Nginx sites detected - all should be operational"
        fi
    else
        print_error "Nginx failed to start"
        print_info "Check logs with: systemctl status nginx"
    fi
}

################################################################################
# Display Installation Summary
################################################################################

display_summary() {
    print_header "Installation Complete!"

    # Determine service name
    if [[ -n "$INSTANCE_NAME" ]]; then
        SERVICE_NAME="simplifyed-${INSTANCE_NAME}"
    else
        SERVICE_NAME="simplifyed"
    fi

    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                                                            ║${NC}"
    echo -e "${GREEN}║         Simplifyed Admin Installation Summary             ║${NC}"
    echo -e "${GREEN}║                                                            ║${NC}"
    echo -e "${GREEN}╠════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║                                                            ║${NC}"
    if [[ -n "$INSTANCE_NAME" ]]; then
        echo -e "${GREEN}║  Instance:         $INSTANCE_NAME${NC}"
    fi
    echo -e "${GREEN}║  Application URL:  https://$DOMAIN${NC}"
    echo -e "${GREEN}║  Application Port: $PORT${NC}"
    echo -e "${GREEN}║  Installation Dir: $INSTALL_DIR${NC}"
    echo -e "${GREEN}║  Application User: $APP_USER${NC}"
    echo -e "${GREEN}║  Service Name:     $SERVICE_NAME${NC}"
    echo -e "${GREEN}║  Database Path:    $INSTALL_DIR/backend/database/simplifyed.db${NC}"
    echo -e "${GREEN}║  Logs Path:        $INSTALL_DIR/backend/logs/${NC}"
    echo -e "${GREEN}║                                                            ║${NC}"
    echo -e "${GREEN}╠════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║  Useful Commands:                                          ║${NC}"
    echo -e "${GREEN}║                                                            ║${NC}"
    echo -e "${GREEN}║  Start service:    systemctl start ${SERVICE_NAME}${NC}"
    echo -e "${GREEN}║  Stop service:     systemctl stop ${SERVICE_NAME}${NC}"
    echo -e "${GREEN}║  Restart service:  systemctl restart ${SERVICE_NAME}${NC}"
    echo -e "${GREEN}║  Service status:   systemctl status ${SERVICE_NAME}${NC}"
    echo -e "${GREEN}║  View logs:        journalctl -u ${SERVICE_NAME} -f${NC}"
    echo -e "${GREEN}║                                                            ║${NC}"
    echo -e "${GREEN}║  Nginx reload:     systemctl reload nginx                  ║${NC}"
    echo -e "${GREEN}║  Nginx status:     systemctl status nginx                  ║${NC}"
    echo -e "${GREEN}║                                                            ║${NC}"
    echo -e "${GREEN}╠════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║  Next Steps:                                               ║${NC}"
    echo -e "${GREEN}║                                                            ║${NC}"

    echo -e "${GREEN}║  1. Visit https://$DOMAIN to access the dashboard${NC}"
    echo -e "${GREEN}║     Auth is handled via Supabase with the credentials you  ║${NC}"
    echo -e "${GREEN}║     provided during install (edit in $INSTALL_DIR/backend/.env).${NC}"

    echo -e "${GREEN}║                                                            ║${NC}"
    echo -e "${GREEN}║  2. Configure OpenAlgo instances in the dashboard          ║${NC}"
    echo -e "${GREEN}║                                                            ║${NC}"
    echo -e "${GREEN}║  3. Import instruments (optional):                         ║${NC}"
    echo -e "${GREEN}║     cd $INSTALL_DIR${NC}"
    echo -e "${GREEN}║     ./import-instruments.sh --exchange NFO --instance-id 1 ║${NC}"
    echo -e "${GREEN}║                                                            ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    print_info "SSL certificate will auto-renew. Check status with: certbot certificates"
    print_info "Environment variables are stored in: $INSTALL_DIR/backend/.env"

    if [[ -n "$INSTANCE_NAME" ]]; then
        echo ""
        print_info "Multi-Instance Setup: To install additional instances (staging, dev, etc.):"
        print_info "  Run this script again with different instance identifiers and domains"
        print_info "  Each instance will have its own directory, user, service, and database"
    fi

    echo ""
}

################################################################################
# Main Installation Flow
################################################################################

main() {
    clear

    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║                                                            ║${NC}"
    echo -e "${BLUE}║     Simplifyed Admin - Automated Installation Script      ║${NC}"
    echo -e "${BLUE}║                                                            ║${NC}"
    echo -e "${BLUE}║  This script will install and configure:                  ║${NC}"
    echo -e "${BLUE}║    • Node.js ${NODE_VERSION}.x                                         ║${NC}"
    echo -e "${BLUE}║    • Simplifyed Admin application                         ║${NC}"
    echo -e "${BLUE}║    • Nginx reverse proxy                                   ║${NC}"
    echo -e "${BLUE}║    • Let's Encrypt SSL certificate                        ║${NC}"
    echo -e "${BLUE}║    • Systemd service                                       ║${NC}"
    echo -e "${BLUE}║    • UFW firewall                                          ║${NC}"
    echo -e "${BLUE}║                                                            ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    read -p "Press Enter to continue or Ctrl+C to cancel..."

    # Pre-installation checks
    check_root
    check_ubuntu

    # Collect user input
    collect_user_input

    # Installation steps
    install_system_packages
    install_nodejs
    create_app_user
    install_application
    configure_environment
    install_dependencies
    build_application
    setup_database
    create_systemd_service
    configure_nginx
    install_ssl_certificate
    configure_firewall
    post_installation

    # Show summary
    display_summary
}

# Run main function
main "$@"
