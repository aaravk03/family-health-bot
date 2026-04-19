# Family Health Bot 🏥

A WhatsApp accountability bot for family health tracking. Sends automated reminders for weight logging, walks, food check-ins, and trainer sessions. Includes a live dashboard.

## Stack
- **Node.js + Express** — web server and webhook
- **PostgreSQL** — data storage (via `pg`, no ORM)
- **Twilio WhatsApp API** — sending and receiving messages
- **node-cron** — scheduled reminders
- **Vanilla HTML/CSS** — auto-refreshing dashboard

## Setup

### 1. Clone & Install
```bash
git clone https://github.com/aaravk03/family-health-bot.git
cd family-health-bot
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your actual values
```

### 3. Run Locally
```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 4. Deploy to Railway
1. Push this repo to GitHub
2. Go to Railway → New Project → Deploy from GitHub
3. Select `family-health-bot` repo
4. Add all variables from `.env` in Settings → Variables
5. Railway will auto-deploy and assign a URL

### 5. Configure Twilio Webhook
In your Twilio console, set the WhatsApp sandbox webhook to:
```
https://YOUR_RAILWAY_URL/webhook
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook` | Twilio incoming message handler |
| GET | `/api/dashboard` | Dashboard JSON data |
| GET | `/dashboard` | HTML dashboard |
| GET | `/health` | Health check |

## Message Commands

Users can send:
- A number like `68.2` → logs weight
- `done` / `yes` / `walked` → confirms walk or trainer session
- Any text → logs as food entry
- A photo → logs as food photo
- `nothing` / `no` → acknowledges food check with no log
- `dashboard` → replies with dashboard URL

## Reminder Schedule (IST)

| Reminder | Time | Days |
|----------|------|------|
| Weight (Mom & Dad) | 7:00 AM (+ every 30 min) | Mon/Wed/Fri |
| Trainer (Mom) | 8:00 AM, 11:00 AM | Mon/Wed/Fri |
| Walk (Mom & Dad) | 9:00 PM, 9:45 PM | Daily |
| Food check-ins | Every hour 8 AM–10 PM | Daily |
