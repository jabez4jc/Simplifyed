# Quick Start Guide - Simplifyed Admin Installation

Get Simplifyed Admin running on your Ubuntu server in under 10 minutes.

## Prerequisites Checklist

Before you begin, ensure you have:

- [ ] Ubuntu 20.04+ server with root/sudo access
- [ ] Domain name pointing to your server's IP
- [ ] Email address for SSL certificate notifications
- [ ] An admin email address and a password (8+ characters) for your first login
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

1. **Instance identifier** - Optional, only needed for running multiple installs side by side (e.g., `prod`, `staging`); press Enter for a single default install
2. **Domain name** - Your fully qualified domain (e.g., admin.example.com)
3. **Email address** - For Let's Encrypt SSL certificate notifications
4. **Application port** - Press Enter for default (3000)
5. **Admin email** - The account created with the Admin role
6. **Admin password** - Entered twice, minimum 8 characters (input is hidden)
7. **Installation directory** - Press Enter for default (/opt/simplifyed)
8. **Telegram bot** - Press Enter to skip or enter bot details

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

Sign in with the admin email and password you set during installation. That account holds the Admin role.

Everyone else is added from **Settings → Access Control** - an admin creates the account and assigns a role. A user with no role assigned can sign in but sees an "access pending" screen until an admin grants one.

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

2. **Add your team**
   - Settings → Access Control → Create User, then assign a role.
   - Users change their own password via `POST /api/v1/auth/change-password`; an admin can reset one from the server with `npm run set-password -- <email> <new-password>`.

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
- **Architecture Guide**: See [ARCHITECTURE.md](ARCHITECTURE.md)

---

## One-Command Installation (Advanced)

Note: the installer still prompts interactively for domain, email, and the admin credentials even when run this way - "one-command" refers to the download+execute step, not a fully unattended install.

If you're confident with the defaults and have DNS configured:

```bash
# Download and run in one go (use with caution!)
wget https://raw.githubusercontent.com/yourusername/simplifyed/main/install.sh
chmod +x install.sh
sudo ./install.sh
```

## Uninstall

Use the uninstall script to remove a specific instance:

```bash
# Auto-detect installed instances and prompt
sudo ./uninstall-instance.sh

# Or target a specific instance identifier (e.g., dev, staging, prod)
sudo ./uninstall-instance.sh --instance dev

# Or target a specific install directory
sudo ./uninstall-instance.sh --dir /opt/simplifyed-dev
```

---

**Installation time**: ~5-10 minutes
**SSL certificate**: Auto-renews every 60 days
**Service**: Auto-starts on server reboot
**Security**: Firewall configured, HTTPS enforced
