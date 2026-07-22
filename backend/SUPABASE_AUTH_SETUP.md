# Supabase Authentication Setup Guide

This guide will help you configure Supabase authentication for the Simplifyed Trading Dashboard.

> **Supabase is optional.** The app also has a built-in email/password login that needs no external
> service: `POST /api/v1/auth/register` bootstraps the first admin account, `POST /api/v1/auth/login`
> signs in. Use Supabase if you want managed identity (magic links, social providers, hosted user
> management); use local auth if you'd rather not depend on an external service. Both can be active
> at once - see `middleware/auth.js`.

## Prerequisites

- A Supabase account (sign up at <https://supabase.com> if you don't have one)
- Node.js 18+ installed
- Access to your server's `.env` file

## Step 1: Create a Supabase Project

1. Go to <https://app.supabase.com>
2. Click "New Project"
3. Enter project details:
   - **Name**: Simplifyed (or your preferred name)
   - **Database Password**: Create a strong password (save this!)
   - **Region**: Choose the closest region to your users
4. Wait for the project to be created (usually takes 1-2 minutes)

## Step 2: Get Your Supabase Credentials

1. In your Supabase project dashboard, go to **Settings** (gear icon in sidebar)
2. Click on **API** in the settings menu
3. You'll see:
   - **Project URL**: `https://your-project-id.supabase.co`
   - **anon public key**: A long JWT token starting with `eyJ...`
   - **service_role secret**: Another JWT token (⚠️ keep this secret!)

4. For the JWT Secret:
   - Scroll down to **JWT Settings**
   - Copy the **JWT Secret** value

## Step 3: Configure Email Authentication

### Enable Email Authentication

1. In your Supabase dashboard, go to **Authentication** → **Providers**
2. Make sure **Email** is enabled (it should be by default)
3. Configure email settings:

   **Option A: Use Supabase's built-in email service (recommended for testing)**
   - This works out of the box
   - Limited to development use
   - Emails may go to spam

   **Option B: Configure custom SMTP (recommended for production)**
   1. Go to **Project Settings** → **Auth** → **SMTP Settings**
   2. Enable custom SMTP
   3. Enter your email provider details:
      - **Host**: e.g., `smtp.gmail.com`
      - **Port**: Usually `587` for TLS or `465` for SSL
      - **Username**: Your email address
      - **Password**: Your email password or app-specific password
      - **Sender email**: The email address users will see
      - **Sender name**: "Simplifyed Trading Dashboard"

### Configure Email Templates

1. Go to **Authentication** → **Email Templates**
2. Customize the email templates:

   **Confirm signup template:**
   ```
   Subject: Confirm your email for Simplifyed

   <h2>Confirm your email</h2>
   <p>Please click the link below to confirm your email address:</p>
   <p><a href="{{ .ConfirmationURL }}">Confirm your email</a></p>
   ```

   **Reset password template:**
   ```
   Subject: Reset your password for Simplifyed

   <h2>Reset your password</h2>
   <p>Click the link below to reset your password:</p>
   <p><a href="{{ .ConfirmationURL }}">Reset password</a></p>
   ```

### Configure Redirect URLs

⚠️ **CRITICAL SECURITY REQUIREMENT**: Redirect URLs must match EXACTLY (including protocol, domain, and path).

1. Go to **Authentication** → **URL Configuration**
2. Add your site URL to **Site URL**: `https://yourdomain.com` (or `http://localhost:3000` for development)
3. Add redirect URLs to **Redirect URLs**:
   - `http://localhost:3000/login.html` (for local development)
   - `https://yourdomain.com/login.html` (for production)
   - Add both if you're using both environments

**Security Note**: If the redirect URL in the email doesn't exactly match one of the configured URLs, authentication will fail. This prevents open redirect vulnerabilities.

## Step 4: Update Your .env File

1. Open `/home/user/Simplifyed/backend/.env`
2. Update the Supabase configuration:

```bash
# Supabase Auth (optional - only needed if you want Supabase as a login method)
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_JWT_SECRET=your-jwt-secret-here
```

**Important:**
- Replace `your-project-id` with your actual project ID from Supabase
- Replace the `SUPABASE_ANON_KEY` with your actual anon public key
- Replace `SUPABASE_JWT_SECRET` with your actual JWT secret
- **Never commit your `.env` file to version control!**

## Step 5: Enable/Disable Email Confirmation

By default, Supabase requires users to confirm their email before they can log in. You can change this:

1. Go to **Authentication** → **Settings**
2. Find **Enable email confirmations**
3. Toggle based on your preference:
   - **Enabled** (recommended): Users must verify their email before logging in
   - **Disabled**: Users can log in immediately after signup (less secure)

## Step 6: Test Your Setup

1. Start your server:

   ```bash
   cd /home/user/Simplifyed/backend
   npm start
   ```

2. Open your browser to `http://localhost:3000/login.html`

3. You should see a modern login page with:
   - Green "Connected" status badge at the top
   - Sign In, Sign Up, and Reset tabs

4. Test the signup flow:
   - Click "Sign Up" tab
   - Enter your email and password
   - Click "Create Account"
   - If email confirmation is enabled, check your email for the confirmation link
   - Click the confirmation link (it should redirect to the login page)
   - Log in with your credentials

5. Verify you're redirected to `/dashboard.html` after successful login

## Step 7: Configure User Roles

The first user to authenticate will automatically be assigned the **Admin** role with full permissions. This applies across both auth methods sharing the same `users` table: if someone already registered via the local `/api/v1/auth/register` endpoint (or `install.sh` pre-seeded an admin email), that already-created row counts as "first user" and the next Supabase login won't get auto-admin.

Subsequent users will be created without a role. You can assign roles through the admin panel once logged in.

## Troubleshooting

### Status Badge Shows "Connection failed"

**Problem:** The login page shows a red error badge

**Solutions:**
1. Check that all three Supabase environment variables are set correctly in `.env`
2. Restart your server after updating `.env`
3. Check browser console for specific error messages
4. Verify your Supabase project is active and not paused

### Email Confirmation Link Not Working

**Problem:** Clicking the email confirmation link doesn't work

**Solutions:**
1. Make sure you've added the redirect URL to Supabase:
   - Go to **Authentication** → **URL Configuration**
   - Add your site URL (e.g., `http://localhost:3000/login.html`)
2. Check that the email template uses `{{ .ConfirmationURL }}` correctly
3. Try copying the link manually instead of clicking it
4. Check browser console for errors

### "Invalid JWT" Error

**Problem:** Login fails with JWT validation error

**Solutions:**
1. Verify `SUPABASE_JWT_SECRET` matches exactly from Supabase dashboard
2. Make sure you're using the JWT Secret, not the anon key or service role key
3. Check that there are no extra spaces or line breaks in your `.env` file
4. Restart the server after changing environment variables

### Emails Not Received

**Problem:** Confirmation emails are not arriving

**Solutions:**
1. Check spam/junk folder
2. If using Supabase's built-in email:
   - It may take a few minutes
   - Check email in Supabase dashboard: **Authentication** → **Users** → Select user → View email logs
3. If using custom SMTP:
   - Verify SMTP credentials are correct
   - Test SMTP connection in Supabase settings
   - Check email provider's outgoing mail logs
4. Try resending the confirmation email from Supabase dashboard

### User Can't Log In After Signup

**Problem:** User created but can't log in

**Solutions:**
1. Check if email confirmation is enabled:
   - Go to **Authentication** → **Settings**
   - If enabled, user must confirm email first
2. Check user status in Supabase dashboard:
   - Go to **Authentication** → **Users**
   - Find the user
   - Check if their email is confirmed
3. Manually confirm the user:
   - In Supabase dashboard, go to **Authentication** → **Users**
   - Click on the user
   - Click "Confirm user"

### "Signup blocked" or Rate Limit Error

**Problem:** Can't create new accounts

**Solutions:**
1. Supabase has rate limits to prevent abuse
2. For development, you can disable rate limiting:
   - Go to **Authentication** → **Settings**
   - Scroll to **Rate Limits**
   - Adjust or disable limits for development
3. For production, rate limits are important for security

## Security Best Practices

1. **Never expose your JWT Secret or service_role key**
   - Only use the `anon` public key on the frontend
   - The JWT secret should only be in your backend `.env` file

2. **Use HTTPS in production**
   - Supabase requires HTTPS for production apps
   - Use Let's Encrypt or your hosting provider's SSL certificate

3. **Enable email confirmation**
   - This prevents fake account creation
   - Verifies users own the email they sign up with

4. **Set up custom SMTP**
   - Supabase's built-in email is for development only
   - Use a proper email service in production (SendGrid, Mailgun, AWS SES, etc.)

5. **Configure password requirements**
   - Go to **Authentication** → **Settings**
   - Set minimum password length (default is 6, recommend 8+)

6. **Enable Row Level Security (RLS)**
   - If you plan to use Supabase database features
   - Prevents unauthorized data access

### localStorage Security Considerations

⚠️ **Important**: Authentication tokens are stored in browser localStorage, which is vulnerable to XSS (Cross-Site Scripting) attacks.

**Risk**: If an attacker can inject malicious JavaScript into your site, they can steal tokens and impersonate users.

**Mitigations**:

1. **Implement Content Security Policy (CSP)**
   - Add CSP headers to prevent unauthorized script execution
   - Example: `Content-Security-Policy: script-src 'self' https://cdn.jsdelivr.net`

2. **Input Validation**
   - Always sanitize user inputs
   - Never use `innerHTML` with user-provided content
   - Use `textContent` or DOM methods instead

3. **Regular Security Audits**
   - Review dependencies for known vulnerabilities
   - Keep packages up to date
   - Monitor for suspicious activity

4. **Consider HttpOnly Cookies (Advanced)**
   - For production deployments, consider migrating to HttpOnly cookies
   - Requires backend changes to manage session cookies
   - Provides better XSS protection

**Note**: The current implementation prioritizes ease of deployment. For high-security requirements, implement HttpOnly cookie-based authentication.

## Next Steps

Once authentication is working:

1. **Customize the login page** (optional)
   - Edit `/home/user/Simplifyed/backend/public/login.html`
   - Update colors, logo, or branding

2. **Set up user roles and permissions**
   - Log in as the first admin user
   - Invite other users
   - Assign appropriate roles (Admin, Trader, Monitor)

3. **Configure production URLs**
   - Update `BASE_URL` in `.env` for production
   - Update Supabase redirect URLs for your domain
   - Set up proper SMTP for email delivery

4. **Monitor authentication**
   - Check Supabase dashboard regularly
   - Review user activity
   - Monitor failed login attempts

## Additional Resources

- [Supabase Auth Documentation](https://supabase.com/docs/guides/auth)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript/auth-signup)
- [Email Templates Guide](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Custom SMTP Configuration](https://supabase.com/docs/guides/auth/auth-smtp)

## Support

If you encounter issues not covered in this guide:

1. Check the browser console for specific error messages
2. Review server logs for backend errors
3. Check Supabase dashboard logs: **Settings** → **Logs**
4. Consult Supabase documentation
5. Open an issue in the project repository

---

**Last Updated:** 2025-11-26
**Version:** 2.0.0
