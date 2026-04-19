require('dotenv').config();
const { query } = require('./db');

const RAILWAY_URL = process.env.RAILWAY_URL || `http://localhost:${process.env.PORT || 3000}`;

/**
 * Look up a user by their WhatsApp number.
 * @param {string} whatsapp - e.g. 'whatsapp:+15109902052'
 * @returns {object|null} user row or null
 */
async function getUserByWhatsapp(whatsapp) {
  const res = await query('SELECT * FROM users WHERE whatsapp = $1', [whatsapp]);
  return res.rows[0] || null;
}

/**
 * Get today's reminder state for a user and type.
 * @param {number} userId
 * @param {string} reminderType - 'weight', 'walk', 'trainer', 'food'
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
 * Mark a reminder as completed for today.
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
 * Determine which pending reminder type is active today for a user.
 * Used to disambiguate 'done'/'yes' replies.
 * Priority: trainer > walk (both could be pending, trainer fires first in AM)
 * @param {number} userId
 * @returns {string|null} 'trainer', 'walk', or null
 */
async function getPendingConfirmationType(userId) {
  const res = await query(
    `SELECT reminder_type FROM reminder_state
     WHERE user_id = $1 AND date = CURRENT_DATE AND completed = FALSE
     AND reminder_type IN ('trainer', 'walk')
     ORDER BY CASE reminder_type WHEN 'trainer' THEN 1 WHEN 'walk' THEN 2 END`,
    [userId]
  );
  return res.rows[0]?.reminder_type || null;
}

/**
 * Log weight for a user.
 */
async function logWeight(userId, weightKg) {
  await query(
    `INSERT INTO weight_logs (user_id, weight_kg) VALUES ($1, $2)`,
    [userId, weightKg]
  );
  await markReminderComplete(userId, 'weight');
}

/**
 * Log a walk confirmation for a user.
 */
async function logWalk(userId) {
  await query(
    `INSERT INTO walk_logs (user_id, confirmed) VALUES ($1, TRUE)`,
    [userId]
  );
  await markReminderComplete(userId, 'walk');
}

/**
 * Log a trainer session for a user.
 */
async function logTrainer(userId) {
  await query(
    `INSERT INTO trainer_logs (user_id, confirmed) VALUES ($1, TRUE)`,
    [userId]
  );
  await markReminderComplete(userId, 'trainer');
}

/**
 * Log a food entry (text or image) for a user.
 */
async function logFood(userId, description, imageUrl = null) {
  await query(
    `INSERT INTO food_logs (user_id, description, image_url) VALUES ($1, $2, $3)`,
    [userId, description, imageUrl]
  );
  await markReminderComplete(userId, 'food');
}

/**
 * Main handler for incoming WhatsApp messages.
 * Parses intent and routes to the correct logging function.
 * Returns a reply string to send back.
 *
 * @param {string} from - sender's WhatsApp number
 * @param {string} body - message text
 * @param {number} numMedia - number of media attachments
 * @param {string|null} mediaUrl - URL of first media attachment
 * @returns {string} reply message
 */
async function handleIncomingMessage(from, body, numMedia, mediaUrl) {
  console.log(`[Handler] From: ${from} | Body: "${body}" | Media: ${numMedia}`);

  // Look up the user
  const user = await getUserByWhatsapp(from);

  if (!user) {
    console.log(`[Handler] Unknown user: ${from}`);
    return "Hi! You're not registered in the family health bot. Ask Aarav to add you.";
  }

  const text = (body || '').trim().toLowerCase();

  // --- Dashboard request ---
  if (text === 'dashboard') {
    return `📊 Here's your dashboard: ${RAILWAY_URL}/dashboard`;
  }

  // --- Image/food photo ---
  if (numMedia > 0 && mediaUrl) {
    await logFood(user.id, body || 'Photo food log', mediaUrl);
    return '✅ Photo logged! Great job tracking your meals 📸';
  }

  // --- Weight: message is just a number like "65.2" or "65" ---
  const weightMatch = text.match(/^\d+(\.\d+)?$/);
  if (weightMatch) {
    const weightKg = parseFloat(text);
    await logWeight(user.id, weightKg);
    return `✅ Got it! Logged ${weightKg} kg. Keep it up! 💪`;
  }

  // --- Confirmation: 'done', 'yes', 'walked', 'completed', 'finished' ---
  const confirmWords = ['done', 'yes', 'walked', 'completed', 'finished'];
  if (confirmWords.includes(text)) {
    // Check which reminder is pending today
    const pendingType = await getPendingConfirmationType(user.id);

    if (pendingType === 'trainer') {
      await logTrainer(user.id);
      return "✅ Trainer session logged! You're crushing it 💪";
    } else if (pendingType === 'walk') {
      await logWalk(user.id);
      return '✅ Amazing! Walk logged for today 🚶‍♀️ Great job!';
    } else {
      // No specific pending reminder — default to walk
      await logWalk(user.id);
      return '✅ Amazing! Walk logged for today 🚶‍♀️ Great job!';
    }
  }

  // --- Skip / no food ---
  if (text === 'nothing' || text === 'no') {
    await markReminderComplete(user.id, 'food');
    return '👍 Got it, noted! Stay hydrated 💧';
  }

  // --- Everything else = food log ---
  await logFood(user.id, body || text, null);
  return '✅ Food logged! Thanks for keeping track 🍽️';
}

module.exports = { handleIncomingMessage, getUserByWhatsapp };
