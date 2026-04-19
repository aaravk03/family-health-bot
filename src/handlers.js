require('dotenv').config();
const { query } = require('./db');
const {
  estimateCaloriesFromImage,
  estimateCaloriesFromText,
  verifyOutdoorPhoto,
} = require('./claude');

const RAILWAY_URL = process.env.RAILWAY_URL || `http://localhost:${process.env.PORT || 3000}`;

// ─── DB Helpers ───────────────────────────────────────────────────────────────

/**
 * Look up a user by their WhatsApp number.
 * @param {string} whatsapp - e.g. 'whatsapp:+15109902052'
 * @returns {object|null}
 */
async function getUserByWhatsapp(whatsapp) {
  const res = await query('SELECT * FROM users WHERE whatsapp = $1', [whatsapp]);
  return res.rows[0] || null;
}

/**
 * Get today's reminder state row for a user + type.
 * Returns null if no reminder has been sent yet today.
 * @param {number} userId
 * @param {string} reminderType
 * @returns {object|null}
 */
async function getReminderState(userId, reminderType) {
  const res = await query(
    `SELECT * FROM reminder_state
     WHERE user_id = $1 AND reminder_type = $2 AND date = CURRENT_DATE`,
    [userId, reminderType]
  );
  return res.rows[0] || null;
}

/**
 * Mark a reminder completed for today (upsert).
 * @param {number} userId
 * @param {string} reminderType
 */
async function markReminderComplete(userId, reminderType) {
  await query(
    `INSERT INTO reminder_state (user_id, reminder_type, date, completed)
     VALUES ($1, $2, CURRENT_DATE, TRUE)
     ON CONFLICT (user_id, reminder_type, date)
     DO UPDATE SET completed = TRUE`,
    [userId, reminderType]
  );
}

/**
 * Check whether a trainer reminder is pending today for a user.
 * Walk is no longer confirmed by text — it requires an outdoor photo.
 * @param {number} userId
 * @returns {boolean}
 */
async function isTrainerPending(userId) {
  const res = await query(
    `SELECT id FROM reminder_state
     WHERE user_id = $1 AND date = CURRENT_DATE
     AND reminder_type = 'trainer' AND completed = FALSE`,
    [userId]
  );
  return res.rows.length > 0;
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
 * Log a food entry. Does NOT block future check-ins (food reminder state is
 * managed separately by the cron skip logic in reminders.js).
 * @param {number} userId
 * @param {string} description
 * @param {string|null} imageUrl
 * @param {number|null} calories
 */
async function logFood(userId, description, imageUrl, calories) {
  await query(
    `INSERT INTO food_logs (user_id, description, image_url, calories) VALUES ($1, $2, $3, $4)`,
    [userId, description, imageUrl ?? null, calories ?? null]
  );
  // Mark food reminder complete so the 90-min skip window is honoured
  await markReminderComplete(userId, 'food');
}

// ─── Reply Builder ────────────────────────────────────────────────────────────

/**
 * Build the food confirmation reply based on Claude's health rating.
 * @param {{ calories: number|null, health: string|null, food: string, coach: string }} result
 * @returns {string}
 */
function buildFoodReply(result) {
  const { calories, health, food, coach } = result;
  const calStr = calories !== null ? ` - ~${calories} calories` : '';

  if (health === 'UNHEALTHY') {
    return `⚠️ ${food} logged${calStr}\n\n${coach}\n\n💪 You've got this - make a better choice next time!`;
  }
  if (health === 'HEALTHY') {
    return `🌟 ${food} logged${calStr}\n\n${coach} Keep crushing it! 💪`;
  }
  if (health === 'MODERATE') {
    return `✅ ${food} logged${calStr}\n\n${coach}`;
  }
  // Fallback if Claude didn't return a recognised health rating
  return calories !== null
    ? `✅ ${food} logged${calStr}`
    : `✅ Food logged! Thanks for keeping track 🍽️`;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

/**
 * Handle an incoming WhatsApp message.
 * Returns the reply string to send back to the user.
 *
 * @param {string} from     - sender WhatsApp number
 * @param {string} body     - message text
 * @param {number} numMedia - number of media attachments
 * @param {string|null} mediaUrl - first media URL (Twilio)
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
    // Check whether a walk reminder is active today (i.e. a row exists and is incomplete).
    // If yes, treat this photo as walk-proof and verify it's outdoors.
    const walkState = await getReminderState(user.id, 'walk');
    if (walkState && !walkState.completed) {
      console.log(`[Handler] Walk pending for ${user.role} — verifying outdoor photo`);
      const isOutdoor = await verifyOutdoorPhoto(mediaUrl);
      if (isOutdoor) {
        await logWalk(user.id);
        return '✅ Walk logged! Great job getting outside today 🌳💪 Keep it up!';
      } else {
        return '❌ That looks like an indoor photo! I need proof you went OUTSIDE. Take a photo outside and send it 🌳';
      }
    }

    // No pending walk — treat as a food photo
    console.log(`[Handler] Treating photo as food log for ${user.role}`);
    const result = await estimateCaloriesFromImage(mediaUrl);
    await logFood(user.id, result.food || 'Photo food log', mediaUrl, result.calories);
    return buildFoodReply(result);
  }

  // ── Weight: bare number like "65" or "65.2" ───────────────────────────────
  if (/^\d+(\.\d+)?$/.test(text)) {
    const weightKg = parseFloat(text);
    await logWeight(user.id, weightKg);
    return `✅ Got it! Logged ${weightKg} kg. Keep it up! 💪`;
  }

  // ── Confirmations: 'done', 'yes', 'completed', 'finished' ────────────────
  // Walk now requires an outdoor photo, so text confirmations only cover trainer.
  const confirmWords = ['done', 'yes', 'walked', 'completed', 'finished'];
  if (confirmWords.includes(text)) {
    if (await isTrainerPending(user.id)) {
      await logTrainer(user.id);
      return "✅ Trainer session logged! You're crushing it 💪";
    }
    // No trainer pending — remind them that walk needs a photo
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
  return buildFoodReply(result);
}

module.exports = { handleIncomingMessage, getUserByWhatsapp };
