# Quick Start Guide - Simplifyed Admin Installation

Get Simplifyed Admin running on your Ubuntu server in under 10 minutes.

## Prerequisites Checklist

Before you begin, ensure you have:

- [ ] Ubuntu 20.04+ server with root/sudo access
- [ ] Domain name pointing to your server's IP
- [ ] Email address for SSL certificate notifications
- [ ] (Optional) Google OAuth credentials
- [ ] (Optional) Telegram bot token

## Installation in 3 Steps

### Step 1: Verify Domain DNS

Make sure your domain resolves to your server:

```bash
dig +short yourdomain.com
```

Should return your server's IP address.

### Step 2: Download and Prepare

```bash
# Clone or upload the repository
git clone https://github.com/jabez4jc/simplifyed.git
cd simplifyed

# Make the installer executable
chmod +x install.sh
```

### Step 3: Run the Installer

```bash
sudo ./install.sh
```

The installer will ask you for:

1. **Domain name** - Your fully qualified domain (e.g., admin.example.com)
2. **Email address** - For Let's Encrypt SSL certificate notifications
3. **Application port** - Press Enter for default (3000)
4. **Installation directory** - Press Enter for default (/opt/simplifyed)
5. **Google OAuth** - Press Enter to skip (TEST MODE) or enter credentials
6. **Telegram bot** - Press Enter to skip or enter bot details

That's it! The script handles everything else automatically.

## What Gets Installed

The installer automatically:

- ✓ Installs Node.js 18.x
- ✓ Sets up the application in /opt/simplifyed
- ✓ Configures Nginx reverse proxy
- ✓ Obtains Let's Encrypt SSL certificate
- ✓ Creates systemd service for auto-start
- ✓ Configures firewall (UFW)
- ✓ Initializes database with migrations
- ✓ Starts all services

## Access Your Application

Once installation completes, open your browser and visit:

```
https://yourdomain.com
```

### If you skipped Google OAuth (TEST MODE):
- Application auto-logs you in
- No password needed
- For testing only - configure OAuth for production

### If you configured Google OAuth:
- Click "Sign in with Google"
- Authorize the application
- Access your dashboard

## Quick Reference Commands

```bash
# View application logs
sudo journalctl -u simplifyed -f

# Restart application
sudo systemctl restart simplifyed

# Check service status
sudo systemctl status simplifyed

# View configuration
sudo cat /opt/simplifyed/backend/.env

# Edit configuration
sudo nano /opt/simplifyed/backend/.env
# (Remember to restart after changes)
```

## Next Steps

1. **Configure OpenAlgo Instances**
   - Log in to the dashboard
   - Add your OpenAlgo broker instances
   - Configure watchlists

2. **Set Up Google OAuth** (if skipped initially)
   ```bash
   sudo nano /opt/simplifyed/backend/.env
   # Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
   sudo systemctl restart simplifyed
   ```

3. **Import Instruments** (for options trading)
   ```bash
   cd /opt/simplifyed
   sudo -u simplifyed ./import-instruments.sh --exchange NFO --instance-id 1
   ```

4. **Set Up Backups**
   ```bash
   # Backup database
   sudo cp /opt/simplifyed/backend/database/simplifyed.db \
          /opt/simplifyed/backend/database/simplifyed.db.backup
   ```

## Troubleshooting

### Service won't start?
```bash
sudo journalctl -u simplifyed -n 100 --no-pager
```

### SSL certificate failed?
```bash
# Verify DNS is resolving
dig +short yourdomain.com

# Try manual certificate
sudo certbot --nginx -d yourdomain.com
```

### Nginx showing 502 error?
```bash
# Check if app is running
sudo systemctl status simplifyed

# Check if port 3000 is listening
sudo netstat -tlnp | grep 3000
```

## Need More Help?

- **Detailed Installation Guide**: See [INSTALL.md](INSTALL.md)
- **Application Documentation**: See [README.md](README.md)
- **Architecture Guide**: See [docs/application_architecture.md](docs/application_architecture.md)

---

## One-Command Installation (Advanced)

If you're confident with the defaults and have DNS configured:

```bash
# Download and run in one go (use with caution!)
wget https://raw.githubusercontent.com/yourusername/simplifyed/main/install.sh
chmod +x install.sh
sudo ./install.sh
```

## Uninstall

To remove everything:

```bash
# Stop services
sudo systemctl stop simplifyed nginx

# Remove application
sudo rm -rf /opt/simplifyed

# Remove service
sudo rm /etc/systemd/system/simplifyed.service
sudo systemctl daemon-reload

# Remove nginx config
sudo rm /etc/nginx/sites-*/simplifyed

# Remove user
sudo userdel -r simplifyed

# Remove SSL cert (optional)
sudo certbot delete --cert-name yourdomain.com
```

---

**Installation time**: ~5-10 minutes
**SSL certificate**: Auto-renews every 60 days
**Service**: Auto-starts on server reboot
**Security**: Firewall configured, HTTPS enforced
