# Simplifyed Admin - Automated Installation Guide

This guide walks you through installing Simplifyed Admin on an Ubuntu server with automatic SSL certificate configuration using Let's Encrypt.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Pre-Installation Checklist](#pre-installation-checklist)
- [Installation](#installation)
- [Post-Installation](#post-installation)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Uninstallation](#uninstallation)

---

## Prerequisites

### Server Requirements

- **Operating System**: Ubuntu 20.04 LTS or later (64-bit)
- **RAM**: Minimum 1GB, recommended 2GB+
- **Storage**: Minimum 10GB free space
- **CPU**: 1 vCPU minimum, 2+ recommended
- **Root Access**: Root or sudo privileges required

### Domain and DNS

- A registered domain name
- DNS A record pointing to your server's public IP address
- Domain must be accessible and resolving before installation

### Optional Services

- **Google OAuth**: Client ID and Secret (for user authentication)
- **Telegram Bot**: Bot token and username (for notifications)

---

## Pre-Installation Checklist

### 1. Verify DNS Resolution

Ensure your domain points to the server:

```bash
# Check DNS resolution
dig +short yourdomain.com

# Or use nslookup
nslookup yourdomain.com
```

The output should show your server's public IP address.

### 2. Update Your Server

```bash
sudo apt-get update
sudo apt-get upgrade -y
```

### 3. Clone or Download the Repository

```bash
# Clone the repository
git clone https://github.com/yourusername/simplifyed.git
cd simplifyed

# Or if you've uploaded files directly
cd /path/to/simplifyed
```

### 4. Make the Installation Script Executable

```bash
chmod +x install.sh
```

---

## Installation

### Run the Installation Script

Execute the installation script with root privileges:

```bash
sudo ./install.sh
```

### During Installation

The script will prompt you for the following information:

#### 1. Domain Configuration

```
Enter your domain name (e.g., admin.example.com):
```

Enter your fully qualified domain name (FQDN).

#### 2. Email Address

```
Enter your email address (for Let's Encrypt notifications):
```

This email receives SSL certificate expiration notices.

#### 3. Application Port (Optional)

```
Enter application port (default: 3000):
```

Press Enter to use the default port (3000), or specify a custom port.

#### 4. Installation Directory (Optional)

```
Enter installation directory (default: /opt/simplifyed):
```

Press Enter to use the default, or specify a custom path.

#### 5. Google OAuth Configuration (Optional)

```
Google OAuth Configuration (optional - press Enter to skip)
Google Client ID:
Google Client Secret:
```

- **Skip**: Press Enter to run in TEST MODE (no authentication required)
- **Configure**: Enter your Google OAuth credentials

To obtain Google OAuth credentials:
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URI: `https://yourdomain.com/auth/google/callback`

#### 6. Telegram Bot Configuration (Optional)

```
Telegram Bot Configuration (optional - press Enter to skip)
Telegram Bot Token:
Telegram Bot Username:
```

To create a Telegram bot:
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Use `/newbot` command and follow instructions
3. Copy the bot token provided
4. Set a username for your bot

### Installation Process

The script will automatically:

1. ✓ Install Node.js 18.x
2. ✓ Install system dependencies (Nginx, SQLite, Certbot, etc.)
3. ✓ Create application user (`simplifyed`)
4. ✓ Copy application files to `/opt/simplifyed`
5. ✓ Generate secure session secret
6. ✓ Create `.env` configuration file
7. ✓ Install NPM dependencies
8. ✓ Build application CSS
9. ✓ Initialize SQLite database
10. ✓ Run database migrations
11. ✓ Create systemd service
12. ✓ Configure Nginx reverse proxy
13. ✓ Obtain Let's Encrypt SSL certificate
14. ✓ Configure UFW firewall
15. ✓ Start all services

### Installation Time

The complete installation typically takes 5-10 minutes depending on your server's specs and internet connection.

---

## Post-Installation

### Access Your Application

Once installation completes, access your application at:

```
https://yourdomain.com
```

#### If Google OAuth is Configured

- Click "Sign in with Google"
- Authorize the application
- You'll be redirected to the dashboard

#### If Running in TEST MODE

- The application automatically logs you in
- No authentication required (development only)
- **Important**: Configure Google OAuth for production use

### Service Management

The application runs as a systemd service named `simplifyed`.

```bash
# Check service status
sudo systemctl status simplifyed

# View live logs
sudo journalctl -u simplifyed -f

# Restart service
sudo systemctl restart simplifyed

# Stop service
sudo systemctl stop simplifyed

# Start service
sudo systemctl start simplifyed

# View last 100 log lines
sudo journalctl -u simplifyed -n 100
```

### Nginx Management

```bash
# Check Nginx status
sudo systemctl status nginx

# Test Nginx configuration
sudo nginx -t

# Reload Nginx (after config changes)
sudo systemctl reload nginx

# View Nginx access logs
sudo tail -f /var/log/nginx/simplifyed-access.log

# View Nginx error logs
sudo tail -f /var/log/nginx/simplifyed-error.log
```

### SSL Certificate Management

Certificates auto-renew automatically. To check certificate status:

```bash
# View certificate details
sudo certbot certificates

# Test renewal process (dry run)
sudo certbot renew --dry-run

# Force certificate renewal
sudo certbot renew --force-renewal
```

---

## Configuration

### Environment Variables

The application configuration is stored in:

```
/opt/simplifyed/backend/.env
```

To modify configuration:

```bash
# Edit the .env file
sudo nano /opt/simplifyed/backend/.env

# After making changes, restart the service
sudo systemctl restart simplifyed
```

### Key Configuration Options

```bash
# Server settings
NODE_ENV=production
PORT=3000
BASE_URL=https://yourdomain.com

# Database
DATABASE_PATH=./database/simplifyed.db

# Session security
SESSION_SECRET=<auto-generated>

# Google OAuth (optional)
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=https://yourdomain.com/auth/google/callback

# Polling intervals (milliseconds)
INSTANCE_POLL_INTERVAL_MS=15000
MARKET_DATA_POLL_INTERVAL_MS=5000

# Telegram (optional)
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_BOT_USERNAME=your-bot-username
```

### Adding Google OAuth After Installation

If you skipped Google OAuth during installation:

1. Edit the .env file:
   ```bash
   sudo nano /opt/simplifyed/backend/.env
   ```

2. Add your credentials:
   ```bash
   GOOGLE_CLIENT_ID=your-actual-client-id
   GOOGLE_CLIENT_SECRET=your-actual-client-secret
   GOOGLE_CALLBACK_URL=https://yourdomain.com/auth/google/callback
   ```

3. Restart the service:
   ```bash
   sudo systemctl restart simplifyed
   ```

### Database Location

The SQLite database is located at:

```
/opt/simplifyed/backend/database/simplifyed.db
```

To backup the database:

```bash
# Create backup
sudo cp /opt/simplifyed/backend/database/simplifyed.db \
       /opt/simplifyed/backend/database/simplifyed.db.backup

# Or with timestamp
sudo cp /opt/simplifyed/backend/database/simplifyed.db \
       /opt/simplifyed/backend/database/simplifyed.db.$(date +%Y%m%d_%H%M%S)
```

### Logs Location

Application logs are stored in:

```
/opt/simplifyed/backend/logs/
```

View logs:

```bash
# Application logs
sudo tail -f /opt/simplifyed/backend/logs/app.log

# System logs (via journalctl)
sudo journalctl -u simplifyed -f
```

---

## Troubleshooting

### Service Won't Start

Check service status and logs:

```bash
sudo systemctl status simplifyed
sudo journalctl -u simplifyed -n 100 --no-pager
```

Common causes:
- Port 3000 already in use
- Database migration failed
- Missing environment variables
- Permission issues

### SSL Certificate Issues

If Let's Encrypt certificate fails:

```bash
# Check if domain resolves correctly
dig +short yourdomain.com

# Try obtaining certificate manually
sudo certbot --nginx -d yourdomain.com

# Check Certbot logs
sudo tail -f /var/log/letsencrypt/letsencrypt.log
```

### Nginx 502 Bad Gateway

This usually means the Node.js application isn't running:

```bash
# Check if simplifyed service is running
sudo systemctl status simplifyed

# Check if application is listening on port 3000
sudo netstat -tlnp | grep 3000

# Restart the service
sudo systemctl restart simplifyed
```

### Database Migration Errors

If migrations fail during installation:

```bash
# Run migrations manually
cd /opt/simplifyed/backend
sudo -u simplifyed npm run migrate

# Check database file permissions
ls -la /opt/simplifyed/backend/database/
```

### Permission Denied Errors

Ensure correct ownership:

```bash
sudo chown -R simplifyed:simplifyed /opt/simplifyed
sudo chmod 600 /opt/simplifyed/backend/.env
```

### Port Already in Use

If port 3000 is occupied:

```bash
# Find what's using the port
sudo lsof -i :3000

# Kill the process (replace PID)
sudo kill -9 PID

# Or change the port in .env
sudo nano /opt/simplifyed/backend/.env
# Change PORT=3000 to another port
sudo systemctl restart simplifyed
```

### View Detailed Logs

```bash
# Last 200 lines with timestamps
sudo journalctl -u simplifyed -n 200 --no-pager

# Follow logs in real-time
sudo journalctl -u simplifyed -f

# Logs from last hour
sudo journalctl -u simplifyed --since "1 hour ago"

# Logs from today
sudo journalctl -u simplifyed --since today
```

---

## Maintenance

### Updating the Application

To update to a new version:

```bash
# 1. Stop the service
sudo systemctl stop simplifyed

# 2. Backup database
sudo cp /opt/simplifyed/backend/database/simplifyed.db \
       /opt/simplifyed/backend/database/simplifyed.db.backup

# 3. Pull latest changes
cd /opt/simplifyed
sudo -u simplifyed git pull

# 4. Install dependencies
cd /opt/simplifyed/backend
sudo -u simplifyed npm install --production

# 5. Run migrations
sudo -u simplifyed npm run migrate

# 6. Build CSS
sudo -u simplifyed npm run build:css

# 7. Restart service
sudo systemctl restart simplifyed
```

### Regular Backups

Set up automated database backups:

```bash
# Create backup script
sudo nano /usr/local/bin/backup-simplifyed.sh
```

Add the following content:

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/simplifyed"
DB_PATH="/opt/simplifyed/backend/database/simplifyed.db"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR
cp $DB_PATH $BACKUP_DIR/simplifyed_$TIMESTAMP.db

# Keep only last 30 days of backups
find $BACKUP_DIR -name "simplifyed_*.db" -mtime +30 -delete
```

Make executable and add to cron:

```bash
sudo chmod +x /usr/local/bin/backup-simplifyed.sh

# Add to crontab (daily at 2 AM)
(crontab -l 2>/dev/null; echo "0 2 * * * /usr/local/bin/backup-simplifyed.sh") | crontab -
```

---

## Uninstallation

To completely remove the application:

```bash
# 1. Stop and disable service
sudo systemctl stop simplifyed
sudo systemctl disable simplifyed
sudo rm /etc/systemd/system/simplifyed.service
sudo systemctl daemon-reload

# 2. Remove Nginx configuration
sudo rm /etc/nginx/sites-enabled/simplifyed
sudo rm /etc/nginx/sites-available/simplifyed
sudo systemctl reload nginx

# 3. Remove application files
sudo rm -rf /opt/simplifyed

# 4. Remove application user
sudo userdel -r simplifyed

# 5. Remove SSL certificates (optional)
sudo certbot delete --cert-name yourdomain.com

# 6. Remove logs
sudo rm -rf /var/log/nginx/simplifyed-*
```

---

## Security Notes

### Firewall

The installation configures UFW with these rules:
- Allow SSH (port 22)
- Allow HTTP (port 80) - redirects to HTTPS
- Allow HTTPS (port 443)
- Deny all other incoming traffic

### SSL/TLS

- Modern TLS protocols only (TLSv1.2 and TLSv1.3)
- Strong cipher suites
- HSTS enabled
- Auto-renewal configured

### Application Security

- Helmet.js for security headers
- Session secrets auto-generated
- Environment variables protected (600 permissions)
- Systemd service runs as non-root user
- Read-only filesystem protection for systemd service

### Recommendations

1. **Change default SSH port** (optional but recommended)
2. **Set up SSH key authentication** and disable password auth
3. **Enable automatic security updates**:
   ```bash
   sudo apt install unattended-upgrades
   sudo dpkg-reconfigure --priority=low unattended-upgrades
   ```
4. **Monitor logs regularly**
5. **Keep backups** of database and configuration
6. **Use strong Google OAuth** instead of TEST MODE in production

---

## Support

For issues or questions:

- Check the [Troubleshooting](#troubleshooting) section
- Review application logs: `sudo journalctl -u simplifyed -f`
- Check GitHub Issues: [Repository Issues](https://github.com/yourusername/simplifyed/issues)
- Read the main documentation: `docs/application_architecture.md`

---

## Additional Resources

- [Main README](README.md)
- [Application Architecture](docs/application_architecture.md)
- [Market Data Feed Service](docs/market_data_feed_service.md)
- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [Nginx Documentation](https://nginx.org/en/docs/)
- [Systemd Service Documentation](https://www.freedesktop.org/software/systemd/man/systemd.service.html)
