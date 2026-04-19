require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { initDB, query } = require('./db');
const { handleIncomingMessage } = require('./handlers');
const { initCrons } = require('./reminders');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// ─── Twilio Webhook ───────────────────────────────────────────────────────────
/**
 * POST /webhook
 * Twilio sends incoming WhatsApp messages here.
 * Must respond with TwiML XML within 5 seconds.
 * Processing happens asynchronously after the response.
 */
app.post('/webhook', (req, res) => {
  // Respond immediately with TwiML so Twilio doesn't time out
  const from = req.body.From || '';
  const body = req.body.Body || '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl = req.body.MediaUrl0 || null;

  console.log(`[Webhook] Incoming message from ${from}: "${body}" | Media: ${numMedia}`);

  // Process asynchronously — don't block the TwiML response
  setImmediate(async () => {
    try {
      const replyText = await handleIncomingMessage(from, body, numMedia, mediaUrl);

      // Send reply via Twilio REST API (since we already flushed TwiML)
      const { sendMessage } = require('./twilio');
      await sendMessage(from, replyText);
    } catch (err) {
      console.error('[Webhook] Error processing message:', err.message);
    }
  });

  // Return empty TwiML — we'll send the actual reply via the REST API above
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
});

// ─── Dashboard API ────────────────────────────────────────────────────────────
/**
 * GET /api/dashboard
 * Returns JSON with health tracking data for mom and dad.
 */
app.get('/api/dashboard', async (req, res) => {
  try {
    // Fetch mom and dad user records
    const usersRes = await query(`SELECT * FROM users WHERE role IN ('mom', 'dad')`);
    const users = usersRes.rows;
    const mom = users.find(u => u.role === 'mom');
    const dad = users.find(u => u.role === 'dad');

    const data = {};

    for (const user of [mom, dad].filter(Boolean)) {
      const role = user.role;

      // Last 30 days of weight logs
      const weightRes = await query(
        `SELECT weight_kg, log_date, logged_at FROM weight_logs
         WHERE user_id = $1 AND logged_at > NOW() - INTERVAL '30 days'
         ORDER BY logged_at DESC`,
        [user.id]
      );

      // Today's food logs
      const foodRes = await query(
        `SELECT description, image_url, logged_at FROM food_logs
         WHERE user_id = $1 AND DATE(logged_at) = CURRENT_DATE
         ORDER BY logged_at ASC`,
        [user.id]
      );

      // Walk confirmations for last 7 days
      const walkRes = await query(
        `SELECT log_date, confirmed FROM walk_logs
         WHERE user_id = $1 AND log_date >= CURRENT_DATE - INTERVAL '6 days'
         ORDER BY log_date ASC`,
        [user.id]
      );

      // Trainer confirmations for last 7 days (mom only)
      let trainerLogs = [];
      if (role === 'mom') {
        const trainerRes = await query(
          `SELECT log_date, confirmed FROM trainer_logs
           WHERE user_id = $1 AND log_date >= CURRENT_DATE - INTERVAL '6 days'
           ORDER BY log_date ASC`,
          [user.id]
        );
        trainerLogs = trainerRes.rows;
      }

      // Reminder compliance this week (% completed)
      const complianceRes = await query(
        `SELECT
           COUNT(*) FILTER (WHERE completed = TRUE) AS done,
           COUNT(*) AS total
         FROM reminder_state
         WHERE user_id = $1 AND date >= DATE_TRUNC('week', CURRENT_DATE)`,
        [user.id]
      );
      const { done, total } = complianceRes.rows[0];
      const compliance = total > 0 ? Math.round((done / total) * 100) : null;

      data[role] = {
        name: user.name,
        weightLogs: weightRes.rows,
        todayFoodLogs: foodRes.rows,
        walkLogs: walkRes.rows,
        trainerLogs,
        compliancePercent: compliance,
      };
    }

    res.json(data);
  } catch (err) {
    console.error('[API] Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
/**
 * GET /dashboard
 * Serves the vanilla HTML dashboard.
 */
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// ─── Startup Diagnostics ──────────────────────────────────────────────────────

/**
 * Log current UTC and IST times, the day of week in IST, and the full
 * reminder schedule so it is easy to verify crons are firing at the right time.
 */
function logStartupInfo() {
  const now = new Date();

  // IST = UTC + 5 hours 30 minutes
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);

  const pad  = (n) => String(n).padStart(2, '0');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const utcStr = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ` +
                 `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;

  const istStr = `${istNow.getUTCFullYear()}-${pad(istNow.getUTCMonth()+1)}-${pad(istNow.getUTCDate())} ` +
                 `${pad(istNow.getUTCHours())}:${pad(istNow.getUTCMinutes())}:${pad(istNow.getUTCSeconds())} IST`;

  const istDay = days[istNow.getUTCDay()];

  console.log('═'.repeat(60));
  console.log(`[Startup] UTC time : ${utcStr}`);
  console.log(`[Startup] IST time : ${istStr}`);
  console.log(`[Startup] Day (IST): ${istDay}`);
  console.log('[Startup] Reminder schedule (all times IST):');
  console.log('  Weight  Mon/Wed/Fri: 7:00, 7:30, 8:00, 8:30, 9:00 AM  → Aarav alert 9:30 AM');
  console.log('  Trainer Mon/Wed/Fri: 8:00 AM  →  11:00 AM  →  Aarav alert 1:00 PM');
  console.log('  Walk    Daily      : 7:00–10:30 PM every 30 min  → Aarav alert 11:00 PM');
  console.log('  Food    Daily      : 8 AM, 10 AM, 12 PM, 2 PM, 4 PM, 6 PM, 8 PM, 10 PM');
  console.log('  Summary Daily      : 10:00 PM (mom calorie total)');
  console.log('═'.repeat(60));
}

// ─── Start Server ─────────────────────────────────────────────────────────────
async function start() {
  try {
    // Initialize DB schema and seed data
    await initDB();

    // Start Express
    app.listen(PORT, () => {
      console.log(`[Server] Running on port ${PORT}`);
      console.log(`[Server] Dashboard: http://localhost:${PORT}/dashboard`);
      console.log(`[Server] Health: http://localhost:${PORT}/health`);
    });

    // Print startup diagnostics before crons start
    logStartupInfo();

    // Initialize all cron jobs
    initCrons();
  } catch (err) {
    console.error('[Server] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
