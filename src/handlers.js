require('dotenv').config();
const { query } = require('./db');
const {
  estimateCaloriesFromImage,
  estimateCaloriesFromText,
  verifyOutdoorPhoto,
} = require('./claude');

const RAILWAY_URL = process.env.RAILWAY_URL || `http://localhost:${process.env.PORT || 3000}`;
const MOM_CALORIE_GOAL = 1200;

// ─── DB Helpers ───────────────────────────────────────────────────────────────

async function getUserByWhatsapp(whatsapp) {
  const res = await query('SELECT * FROM users WHERE whatsapp = $1', [whatsapp]);
  return res.rows[0] || null;
}

async function getReminderState(userId, reminderType) {
  const res = await query(
    `SELECT * FROM reminder_state
     WHERE user_id = $1 AND reminder_type = $2 AND date = CURRENT_DATE`,
    [userId, reminderType]
  );
  return res.rows[0] || null;
}

async function markReminderComplete(userId, reminderType) {
  await query(
    `INSERT INTO reminder_state (user_id, reminder_type, date, completed)
     VALUES ($1, $2, CURRENT_DATE, TRUE)
     ON CONFLICT (user_id, reminder_type, date)
     DO UPDATE SET completed = TRUE`,
    [userId, reminderType]
  );
}

async function isTrainerPending(userId) {
  const res = await query(
    `SELECT id FROM reminder_state
     WHERE user_id = $1 AND date = CURRENT_DATE
     AND reminder_type = 'trainer' AND completed = FALSE`,
    [userId]
  );
  return res.rows.length > 0;
}

/**
 * Return today's total logged calories for a user.
 * Uses DATE(logged_at) since the food_logs table has no separate log_date column.
 */
async function getTodayCalorieTotal(userId) {
  const res = await query(
    `SELECT COALESCE(SUM(calories), 0) AS total
     FROM food_logs
     WHERE user_id = $1 AND DATE(logged_at) = CURRENT_DATE`,
    [userId]
  );
  return parseInt(res.rows[0].total, 10);
}

// ─── Logging Helpers ──────────────────────────────────────────────────────────

async function logWeight(userId, weightKg) {
  await query(`INSERT INTO weight_logs (user_id, weight_kg) VALUES ($1, $2)`, [userId, weightKg]);
  await markReminderComplete(userId, 'weight');
}

async function logWalk(userId) {
  await query(`INSERT INTO walk_logs (user_id, confirmed) VALUES ($1, TRUE)`, [userId]);
  await markReminderComplete(userId, 'walk');
}

async function logTrainer(userId) {
  await query(`INSERT INTO trainer_logs (user_id, confirmed) VALUES ($1, TRUE)`, [userId]);
  await markReminderComplete(userId, 'trainer');
}

/**
 * Insert a food entry. Marks the food reminder complete so the 90-min
 * skip window in reminders.js is honoured.
 */
async function logFood(userId, description, imageUrl, calories) {
  await query(
    `INSERT INTO food_logs (user_id, description, image_url, calories)
     VALUES ($1, $2, $3, $4)`,
    [userId, description, imageUrl ?? null, calories ?? null]
  );
  await markReminderComplete(userId, 'food');
}

// ─── Reply Builder ────────────────────────────────────────────────────────────

/**
 * Build the food confirmation reply.
 *
 * For mom (role === 'mom'): appends a running calorie total and remaining
 * budget against the 1200-calorie daily goal.
 *
 * @param {{ calories: number|null, health: string|null, food: string, coach: string }} result
 * @param {number} userId
 * @param {string} role
 * @returns {Promise<string>}
 */
async function buildFoodReply(result, userId, role) {
  const { calories, health, food, coach } = result;
  const calStr = calories !== null ? ` - ~${calories} calories` : '';

  // Build the base message from the health rating
  let base;
  if (health === 'UNHEALTHY') {
    base = `⚠️ ${food} logged${calStr}\n\n${coach}\n\n💪 You've got this - make a better choice next time!`;
  } else if (health === 'HEALTHY') {
    base = `🌟 ${food} logged${calStr}\n\n${coach} Keep crushing it! 💪`;
  } else if (health === 'MODERATE') {
    base = `✅ ${food} logged${calStr}\n\n${coach}`;
  } else {
    // Fallback when Claude didn't return a recognised health rating
    base = calories !== null
      ? `✅ ${food} logged${calStr}`
      : `✅ Food logged! Thanks for keeping track 🍽️`;
  }

  // ── Running calorie total (mom only) ────────────────────────────────────
  if (role === 'mom') {
    const total     = await getTodayCalorieTotal(userId);
    const remaining = MOM_CALORIE_GOAL - total;

    // Main 📊 line
    const remainingDisplay = remaining > 0 ? remaining : 0;
    base += `\n\n📊 Today so far: ~${total} calories | ${remainingDisplay} remaining of ${MOM_CALORIE_GOAL}`;

    // Warning line (only one fires — over-limit takes priority)
    if (remaining <= 0) {
      base += `\n🚨 You've hit your ${MOM_CALORIE_GOAL} calorie limit for today! Try to avoid eating anything else.`;
    } else if (remaining <= 200) {
      base += `\n⚠️ Only ${remaining} calories left for today - be careful!`;
    }
  }

  return base;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

/**
 * Handle an incoming WhatsApp message and return the reply string.
 *
 * @param {string} from         - sender's WhatsApp number
 * @param {string} body         - message body text
 * @param {number} numMedia     - number of media attachments
 * @param {string|null} mediaUrl - first Twilio media URL
 * @returns {Promise<string>}
 */
async function handleIncomingMessage(from, body, numMedia, mediaUrl) {
  console.log(`[Handler] From: ${from} | Body: "${body}" | Media: ${numMedia}`);

  const user = await getUserByWhatsapp(from);
  if (!user) {
    console.log(`[Handler] Unknown user: ${from}`);
    return "Hi! You're not registered in the family health bot. Ask Aarav to add you.";
  }

  const text = (body || '').trim().toLowerCase();

  // ── Dashboard shortcut ────────────────────────────────────────────────────
  if (text === 'dashboard') {
    return `📊 Here's your dashboard: ${RAILWAY_URL}/dashboard`;
  }

  // ── Photo received ────────────────────────────────────────────────────────
  if (numMedia > 0 && mediaUrl) {
    // If a walk reminder is active and incomplete, verify outdoor photo first.
    const walkState = await getReminderState(user.id, 'walk');
    if (walkState && !walkState.completed) {
      console.log(`[Handler] Walk pending for ${user.role} — verifying outdoor photo`);
      const isOutdoor = await verifyOutdoorPhoto(mediaUrl);
      if (isOutdoor) {
        await logWalk(user.id);
        return '✅ Walk logged! Great job getting outside today 🌳💪 Keep it up!';
      }
      return '❌ That looks like an indoor photo! I need proof you went OUTSIDE. Take a photo outside and send it 🌳';
    }

    // No pending walk — treat as a food photo
    console.log(`[Handler] Treating photo as food log for ${user.role}`);
    const result = await estimateCaloriesFromImage(mediaUrl);
    await logFood(user.id, result.food || 'Photo food log', mediaUrl, result.calories);
    return await buildFoodReply(result, user.id, user.role);
  }

  // ── Weight: bare number like "65" or "65.2" ───────────────────────────────
  if (/^\d+(\.\d+)?$/.test(text)) {
    const weightKg = parseFloat(text);
    await logWeight(user.id, weightKg);
    return `✅ Got it! Logged ${weightKg} kg. Keep it up! 💪`;
  }

  // ── Confirmations: 'done', 'yes', 'walked', 'completed', 'finished' ──────
  // Walk now requires an outdoor photo — text confirms only cover trainer.
  const confirmWords = ['done', 'yes', 'walked', 'completed', 'finished'];
  if (confirmWords.includes(text)) {
    if (await isTrainerPending(user.id)) {
      await logTrainer(user.id);
      return "✅ Trainer session logged! You're crushing it 💪";
    }
    return "👍 Got it! If you're confirming your walk, please send an outdoor photo as proof 🌳📸";
  }

  // ── Skip / nothing eaten ──────────────────────────────────────────────────
  if (text === 'nothing' || text === 'no') {
    await markReminderComplete(user.id, 'food');
    return '👍 Got it, noted! Stay hydrated 💧';
  }

  // ── Everything else = text food log with calorie coaching ─────────────────
  const result = await estimateCaloriesFromText(body || text);
  await logFood(user.id, result.food || body || text, null, result.calories);
  return await buildFoodReply(result, user.id, user.role);
}

module.exports = { handleIncomingMessage, getUserByWhatsapp };
