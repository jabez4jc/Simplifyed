# Manual Telegram Linking Workaround

Since Telegram polling is blocked in this environment, use this manual process:

## Step 1: Generate Linking Code (via API)
```bash
curl -X POST http://localhost:3000/api/v1/telegram/link \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=YOUR_SESSION_COOKIE"
```

This returns:
```json
{
  "status": "success",
  "data": {
    "linking_code": "LINK-ABC123XYZ",
    "bot_username": "simplifyed_trading_bot",
    "link_url": "https://t.me/simplifyed_trading_bot?start=LINK-ABC123XYZ",
    "expires_at": "2024-11-14T07:00:00.000Z"
  }
}
```

## Step 2: Get Your Telegram Chat ID

1. Open Telegram and search for `@simplifyed_trading_bot`
2. Send any message to the bot (e.g., "/start")
3. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Find your `chat_id` in the JSON response under `result[0].message.chat.id`

**Note:** Replace `<YOUR_BOT_TOKEN>` with your actual bot token from the `.env` file (`TELEGRAM_BOT_TOKEN`).

## Step 3: Manually Link Account (Direct Database)

```bash
# Insert into database
sqlite3 database/simplifyed.db << SQL
INSERT OR REPLACE INTO user_telegram_config 
(user_id, telegram_chat_id, telegram_username, linking_code, is_active, enabled, linked_at)
VALUES 
(1, 'YOUR_CHAT_ID', 'your_telegram_username', null, 1, 1, datetime('now'));
SQL
```

Replace:
- `YOUR_CHAT_ID`: The chat ID from Step 2
- `your_telegram_username`: Your Telegram username (optional)
- `1`: User ID (default test user)

## Step 4: Verify Linking

```bash
curl http://localhost:3000/api/v1/telegram/status \
  -H "Cookie: connect.sid=YOUR_SESSION_COOKIE"
```

Should return:
```json
{
  "status": "success",
  "data": {
    "is_linked": true,
    "is_active": true,
    "username": "your_telegram_username"
  }
}
```

## Step 5: Test Alert (Optional)

Send a test message to verify notifications work:
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/sendMessage?chat_id=YOUR_CHAT_ID&text=Test%20from%20Simplifyed"
```

**Note:** Replace `<YOUR_BOT_TOKEN>` with your actual bot token from the `.env` file.
