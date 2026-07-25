# Complete Beginner's Guide to Installing Simplifyed Admin

This guide assumes you have **no prior experience** with Linux servers. We'll walk through everything step-by-step.

## What You'll Need

Before starting, make sure you have:

1. ✅ An Ubuntu server (from providers like DigitalOcean, AWS, Linode, Vultr, etc.)
2. ✅ Your server's IP address (looks like: `123.45.67.89`)
3. ✅ SSH login credentials (username and password or SSH key)
4. ✅ A domain name (like `admin.example.com`) already pointing to your server's IP
5. ✅ An email address for SSL certificate notifications

---

## Step 1: Connect to Your Server

### On Windows

**Option A: Using PowerShell (Built-in)**

1. Press `Windows Key + X` and select "Windows PowerShell" or "Terminal"
2. Type this command (replace with your server's IP):
   ```
   ssh root@123.45.67.89
   ```
3. If asked "Are you sure you want to continue connecting?", type `yes` and press Enter
4. Enter your password when prompted (you won't see it as you type - this is normal)

**Option B: Using PuTTY (If you prefer a GUI)**

1. Download PuTTY from https://www.putty.org/
2. Open PuTTY
3. In "Host Name" field, enter your server's IP address
4. Click "Open"
5. Enter username (usually `root`) and password when prompted

### On Mac or Linux

1. Open Terminal (press `Cmd + Space`, type "Terminal", and press Enter)
2. Type this command (replace with your server's IP):
   ```
   ssh root@123.45.67.89
   ```
3. Enter your password when prompted

### ✅ Success Check
If you see something like `root@yourserver:~#` or `root@yourserver:~$`, you're successfully connected!

---

## Step 2: Get the Installation Files onto Your Server

You have **three options**. Choose the one that works best for you:

### **Option A: Download from GitHub (Easiest - Recommended)**

If your code is on GitHub, this is the simplest method:

```bash
# Navigate to a working directory
cd /root

# Download the repository
git clone https://github.com/yourusername/simplifyed.git

# Enter the directory
cd simplifyed
```

**Replace `yourusername` with your actual GitHub username.**

If you get an error saying "git: command not found", install it first:
```bash
apt-get update
apt-get install -y git
```

Then try the git clone command again.

---

### **Option B: Download as ZIP (If you have the files on your computer)**

If you've already downloaded or have the files on your local computer:

**Step 1: On your local computer**

1. Make sure all the files are in a folder named `simplifyed`
2. Create a ZIP file:
   - **Windows**: Right-click the folder → "Send to" → "Compressed (zipped) folder"
   - **Mac**: Right-click the folder → "Compress simplifyed"

**Step 2: Upload to your server**

Using SCP (Secure Copy):

**From Windows PowerShell or Mac/Linux Terminal:**
```bash
scp simplifyed.zip root@123.45.67.89:/root/
```

Replace `123.45.67.89` with your server's IP address.

**Step 3: On your server (SSH session)**

```bash
# Install unzip if needed
apt-get update
apt-get install -y unzip

# Unzip the file
cd /root
unzip simplifyed.zip

# Enter the directory
cd simplifyed
```

---

### **Option C: Using an FTP Client (Most Visual)**

If you prefer a graphical interface:

**Step 1: Download FileZilla**
- Go to https://filezilla-project.org/
- Download and install FileZilla Client

**Step 2: Connect to your server**
1. Open FileZilla
2. At the top, fill in:
   - **Host**: `sftp://123.45.67.89` (your server IP)
   - **Username**: `root`
   - **Password**: your server password
   - **Port**: `22`
3. Click "Quickconnect"

**Step 3: Upload files**
1. On the left side (Local site), navigate to where you have the `simplifyed` folder on your computer
2. On the right side (Remote site), navigate to `/root`
3. Drag the `simplifyed` folder from left to right
4. Wait for upload to complete

**Step 4: Back in your SSH session**
```bash
cd /root/simplifyed
```

---

## Step 3: Verify Files Are There

Once you're in the simplifyed directory, verify the installation script is there:

```bash
ls -la install.sh
```

You should see something like:
```
-rwx--x--x 1 root root 24576 Nov 26 13:55 install.sh
```

If you see "No such file or directory", the files didn't upload correctly. Go back to Step 2.

---

## Step 4: Run the Pre-Installation Check (Optional but Recommended)

This checks if your server is ready:

```bash
bash pre-install-check.sh
```

This will check your system and tell you if anything needs fixing before installation.

**Look for:**
- ✓ Green checkmarks = good
- ⚠ Yellow warnings = review but usually OK
- ✗ Red X's = must fix before proceeding

---

## Step 5: Run the Installation

Now run the main installer:

```bash
sudo ./install.sh
```

### What You'll Be Asked

The installer will ask you several questions. Here's what to enter:

#### 1. **Instance Identifier** (Just press Enter, unless you're running more than one install)
```
Enter instance identifier (or press Enter to skip):
```
Only needed if you want multiple installs on the same server (e.g. `prod`, `staging`, `dev` side by side). Press **Enter** for a normal single install.

---

#### 2. **Domain Name**
```
Enter your domain name (e.g., admin.example.com):
```
Enter your full domain (like `admin.mycompany.com`)

**Important:** Your domain MUST already be pointing to your server's IP address!

To check, on your local computer, open Command Prompt/Terminal and run:
```bash
ping admin.mycompany.com
```
It should show your server's IP address.

---

#### 3. **Email Address**
```
Enter your email address (for Let's Encrypt notifications):
```
Enter your email. You'll receive notifications when your SSL certificate is about to expire (it auto-renews, so this is just for alerts).

---

#### 4. **Application Port** (Just press Enter)
```
Enter application port (default: 3000):
```
Just press **Enter** to use the default port 3000.

---

#### 5. **Admin Email**

```
Enter admin user email (first login will be granted Admin):
```

Enter the email address you'll sign in with. The installer pre-grants this exact email the Admin role, so whoever logs in with it first gets full access.

---

#### 6. **Installation Directory** (Just press Enter)
```
Installation directory (default: /opt/simplifyed):
```
Just press **Enter** to use the default `/opt/simplifyed`.

---

#### 7. **Admin Password** (Required)

```
Enter admin password (min 8 characters):
Confirm admin password:
```

This is the password for the admin email you entered earlier - together they are how you log in for the first time. There's no skip option.

**What you'll notice:** nothing appears as you type. That's deliberate - the password is hidden so it doesn't end up visible on screen or in your terminal history. Type it and press Enter, then type it again to confirm.

Pick something you'll actually remember, or store it in a password manager now. The app never displays it again - it stores only a bcrypt hash, which cannot be reversed. If you do lose it, you can reset it from the server later (see [Forgot Your Password?](#forgot-your-password) below), so it isn't fatal - just inconvenient.

There's no external service involved in login. The app handles accounts itself.

---

#### 8. **Telegram Bot Configuration** (Optional)

```
Telegram Bot Configuration (optional - press Enter to skip)
Telegram Bot Token:
```

**If you DON'T want Telegram notifications:**
- Just press **Enter** twice to skip

**If you DO want Telegram notifications:**
1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow instructions to create your bot
4. Copy the token you receive
5. Enter the token when prompted

---

### Installation Progress

The script will now automatically:

1. ✓ Install Node.js
2. ✓ Install Nginx
3. ✓ Install SSL certificates
4. ✓ Set up the application
5. ✓ Configure firewall
6. ✓ Start all services

This takes **5-10 minutes**. You'll see progress messages as it works.

---

## Step 6: Access Your Application

When installation completes, you'll see a success message with your application URL.

**Open your web browser and go to:**
```
https://yourdomain.com
```

Sign in with the admin email and password you entered during installation. That account has full admin access.

---

## Common Issues and Solutions

### Issue 1: "Permission denied" when running install.sh

**Solution:**
```bash
chmod +x install.sh
sudo ./install.sh
```

---

### Issue 2: Domain shows SSL certificate error

**Problem:** Your domain isn't resolving yet.

**Solution:**
1. Wait 5-10 minutes for DNS to propagate
2. Verify DNS is working:
   ```bash
   dig +short yourdomain.com
   ```
   Should show your server's IP

---

### Issue 3: Can't connect to SSH

**Solutions:**
- Verify you're using the correct IP address
- Check if your hosting provider's firewall is blocking port 22
- Try adding your SSH port explicitly: `ssh -p 22 root@yourip`
- Contact your hosting provider's support

---

### Issue 4: Installation fails with "port already in use"

**Solution:**
```bash
# Check what's using port 3000
sudo lsof -i :3000

# If something is there, either:
# Option 1: Kill it
sudo kill -9 <PID>

# Option 2: Use a different port when the installer asks
```

---

### Issue 5: Website shows "502 Bad Gateway"

**Check if the application is running:**
```bash
sudo systemctl status simplifyed
```

**If it says "inactive" or "failed":**
```bash
# Restart it
sudo systemctl restart simplifyed

# Check logs for errors
sudo journalctl -u simplifyed -n 50
```

---

## After Installation - What to Do Next

### 1. Add Your First OpenAlgo Instance

1. Log in to your dashboard
2. Click "Instances" or "Add Instance"
3. Enter your OpenAlgo broker details
4. Save

### 2. Create Watchlists

1. Go to "Watchlists"
2. Click "Create New Watchlist"
3. Add symbols you want to track

### 3. Add Your Team

Other people can't sign themselves up - an admin creates each account:

1. Go to **Settings → Access Control**
2. Click **Create User**, enter their email and a starting password
3. Assign them a role

Roles decide what someone can do. Until you assign one, that person can log in but only sees an "access pending" screen - so creating the account and assigning the role are both needed.

Ask them to change the starting password after their first login (**Settings**, or `POST /api/v1/auth/change-password`).

### 4. Forgot Your Password?

Nothing is lost - reset it from the server over SSH:

```bash
cd /opt/simplifyed/backend
sudo -u simplifyed npm run set-password -- your@email.com your-new-password
```

Then log in with the new password. This only works on an account that already exists, and only from the server - there's no way to trigger it over the internet, which is exactly why it's safe to leave available.

---

## Useful Commands for Later

```bash
# View application logs
sudo journalctl -u simplifyed -f

# Restart application
sudo systemctl restart simplifyed

# Stop application
sudo systemctl stop simplifyed

# Start application
sudo systemctl start simplifyed

# Check if application is running
sudo systemctl status simplifyed

# View configuration
sudo cat /opt/simplifyed/backend/.env

# Edit configuration
sudo nano /opt/simplifyed/backend/.env
# (Remember to restart after changes)
```

---

## Getting Help

If you're stuck:

1. **Check the logs:**
   ```bash
   sudo journalctl -u simplifyed -n 100
   ```

2. **Check detailed documentation:**
   - See [INSTALL.md](INSTALL.md) for detailed troubleshooting
   - See [QUICKSTART.md](QUICKSTART.md) for quick reference

3. **Common log locations:**
   - Application logs: `/opt/simplifyed/backend/logs/app.log`
   - Nginx logs: `/var/log/nginx/simplifyed-error.log`
   - System logs: `sudo journalctl -u simplifyed`

---

## Video Tutorial Alternative

If you prefer video instructions, here's what to search for on YouTube:

1. "How to SSH into Ubuntu server" - for Step 1
2. "How to use FileZilla to upload files to server" - for Step 2 (Option C)
3. "Ubuntu server command line basics" - general Linux commands

---

## Quick Reference Card

**Print or save this for quick access:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MY SERVER DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Server IP: ___________________________
Domain: _______________________________
Email: ________________________________
SSH Username: _________________________

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUICK COMMANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Connect to server:
  ssh root@[YOUR_IP]

View logs:
  sudo journalctl -u simplifyed -f

Restart app:
  sudo systemctl restart simplifyed

Edit config:
  sudo nano /opt/simplifyed/backend/.env
  (Ctrl+X, Y, Enter to save)

Application URL:
  https://[YOUR_DOMAIN]

Installation location:
  /opt/simplifyed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Summary

1. **Connect to server** via SSH
2. **Get files** using git clone, SCP, or FileZilla
3. **Verify files** with `ls -la install.sh`
4. **Run installer** with `sudo ./install.sh`
5. **Answer prompts** (domain, email, admin email, admin password)
6. **Wait 5-10 minutes** for installation
7. **Access** at `https://yourdomain.com`

You've got this! Follow the steps carefully, and you'll have Simplifyed Admin running in no time. 🚀
