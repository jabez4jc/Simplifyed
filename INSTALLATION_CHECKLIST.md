# Installation Checklist - Print This!

Use this checklist to track your installation progress.

---

## Pre-Installation Checklist

- [ ] I have an Ubuntu server (20.04 or later)
- [ ] I have my server's IP address: `_______________________`
- [ ] I have SSH access credentials
- [ ] I have a domain name: `_______________________`
- [ ] My domain's DNS A record points to my server IP
- [ ] I verified DNS with: `ping mydomain.com`
- [ ] I have an email address for SSL notifications: `_______________________`

### Optional (can do later):
- [ ] I have Google OAuth Client ID: `_______________________`
- [ ] I have Google OAuth Client Secret: `_______________________`
- [ ] I have Telegram Bot Token: `_______________________`

---

## Installation Steps

### Step 1: Connect to Server
- [ ] Connected via SSH: `ssh root@MY_SERVER_IP`
- [ ] I see the command prompt: `root@myserver:~#`

### Step 2: Get Installation Files
Choose one method:

**Option A: Git Clone (Recommended)**
- [ ] Installed git: `apt-get update && apt-get install -y git`
- [ ] Cloned repository: `git clone https://github.com/USERNAME/simplifyed.git`
- [ ] Changed directory: `cd simplifyed`

**Option B: Upload via SCP**
- [ ] Created ZIP file on my computer
- [ ] Uploaded: `scp simplifyed.zip root@MY_IP:/root/`
- [ ] Connected via SSH
- [ ] Unzipped: `unzip simplifyed.zip`
- [ ] Changed directory: `cd simplifyed`

**Option C: Upload via FileZilla**
- [ ] Downloaded and installed FileZilla
- [ ] Connected to server
- [ ] Uploaded simplifyed folder to `/root`
- [ ] Changed directory in SSH: `cd /root/simplifyed`

### Step 3: Verify Files
- [ ] Verified install script exists: `ls -la install.sh`
- [ ] I see the install.sh file listed

### Step 4: Pre-Installation Check (Optional)
- [ ] Ran pre-check: `bash pre-install-check.sh`
- [ ] Reviewed results (no critical failures)

### Step 5: Run Installation
- [ ] Started installer: `sudo ./install.sh`
- [ ] Entered domain name: `_______________________`
- [ ] Entered email address: `_______________________`
- [ ] Entered or skipped application port (default: 3000)
- [ ] Entered or skipped installation directory (default: /opt/simplifyed)
- [ ] Entered or skipped Google OAuth credentials
- [ ] Entered or skipped Telegram bot details
- [ ] Installation completed without errors
- [ ] Saw success message

### Step 6: Access Application
- [ ] Opened browser to: `https://MY_DOMAIN`
- [ ] SSL certificate is valid (green lock icon)
- [ ] Logged in successfully
- [ ] Can see the dashboard

---

## Post-Installation Tasks

### Immediate Tasks
- [ ] Verified application is running: `sudo systemctl status simplifyed`
- [ ] Tested application functionality
- [ ] Reviewed logs: `sudo journalctl -u simplifyed -n 50`

### Configuration Tasks
- [ ] Added first OpenAlgo instance
- [ ] Created first watchlist
- [ ] Tested placing an order (if applicable)

### Security Tasks (If Not Done)
- [ ] Configured Google OAuth (if skipped during installation)
- [ ] Changed SSH password or added SSH key authentication
- [ ] Reviewed firewall rules: `sudo ufw status`

### Backup and Maintenance
- [ ] Noted database location: `/opt/simplifyed/backend/database/simplifyed.db`
- [ ] Noted config file location: `/opt/simplifyed/backend/.env`
- [ ] Bookmarked this page for future reference

---

## Important Commands to Remember

```bash
# View live application logs
sudo journalctl -u simplifyed -f

# Restart application
sudo systemctl restart simplifyed

# Check application status
sudo systemctl status simplifyed

# Edit configuration (restart after changes)
sudo nano /opt/simplifyed/backend/.env
sudo systemctl restart simplifyed

# Check SSL certificate
sudo certbot certificates

# Backup database
sudo cp /opt/simplifyed/backend/database/simplifyed.db \
       /opt/simplifyed/backend/database/backup.db
```

---

## Troubleshooting Quick Reference

| Problem | Quick Fix |
|---------|-----------|
| Can't SSH to server | Check IP, check if port 22 is open, verify credentials |
| Domain shows SSL error | Wait 10 mins for DNS propagation, verify with `dig +short mydomain.com` |
| 502 Bad Gateway | Restart app: `sudo systemctl restart simplifyed` |
| Application won't start | Check logs: `sudo journalctl -u simplifyed -n 100` |
| Forgot configuration | View: `sudo cat /opt/simplifyed/backend/.env` |
| Port 3000 in use | Check: `sudo lsof -i :3000`, kill process or use different port |

---

## Contact Information for Help

**Documentation:**
- Beginner Guide: [BEGINNER_GUIDE.md](BEGINNER_GUIDE.md)
- Quick Start: [QUICKSTART.md](QUICKSTART.md)
- Detailed Install: [INSTALL.md](INSTALL.md)
- Main README: [README.md](README.md)

**Support:**
- Check application logs first
- Review troubleshooting section in documentation
- GitHub Issues: [Repository URL]

---

## My Installation Notes

Use this space to write down any custom configurations or notes:

```
Server Provider: _________________________________

Custom Port (if different from 3000): ___________

Google OAuth Setup Date: _________________________

Additional Notes:
________________________________________________
________________________________________________
________________________________________________
________________________________________________
________________________________________________
________________________________________________
```

---

## Installation Completion

**Installation Date:** `_______________`
**Installed By:** `_______________`
**Application URL:** `https://_______________`
**Status:** ✅ Completed Successfully

---

**Save this checklist for future reference and updates!**
