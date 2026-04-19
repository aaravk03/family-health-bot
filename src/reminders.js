require('dotenv').config();
const cron = require('node-cron');
const { query } = require('./db');
const { sendMessage } = require('./twilio');

// WhatsApp numbers from env
const MOM = process.env.MOM_WHATSAPP;
const DAD = process.env.DAD_WHATSAPP;
const AARAV = process.env.AARAV_WHATSAPP;

// ─── Escalating weight reminder messages ─────────────────────────────────────
const WEIGHT_REMINDERS = [
  `⚖️ Good morning! Time to weigh yourself 🌅\n\nInstructions:\n✅ RIGHT NOW before eating or drinking anything\n✅ After using the bathroom\n✅ No clothes if possible\n\nReply with your weight in kg (example: 68.2)`,
  `⚖️ Still waiting! Don't ignore me 😤 Reply with your weight like: 68.2`,
  `😤 I'm not going away until you weigh yourself. Number. Now.`,
  `⚖️ WEIGHT. NOW. Please 🙏`,
  `Still nothing?? Telling Aarav in 30 minutes if you don't log 😤`,
  `Last warning before I alert Aarav! Send your weight NOW ⚖️`,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get a user by their role from the database.
 * @param {string} role - 'mom', 'dad', 'admin'
 */
async function getUserByRole(role) {
  const res = await query('SELECT * FROM users WHERE role = $1', [role]);
  return res.rows[0] || null;
}

/**
 * Get or create today's reminder state row for a user+type.
 * Returns the current reminder_state row.
 */
async function getOrCreateReminderState(userId, reminderType) {
  await query(
    `INSERT INTO reminder_state (user_id, reminder_type, date, completed, reminder_count)
     VALUES ($1, $2, CURRENT_DATE, FALSE, 0)
     ON CONFLICT (user_id, reminder_type, date) DO NOTHING`,
    [userId, reminderType]
  );
  const res = await query(
    `SELECT * FROM reminder_state
     WHERE user_id = $1 AND reminder_type = $2 AND date = CURRENT_DATE`,
    [userId, reminderType]
  );
  return res.rows[0];
}

/**
 * Increment the reminder_count and update last_reminded_at.
 */
async function bumpReminderCount(userId, reminderType) {
  await query(
    `UPDATE reminder_state
     SET reminder_count = reminder_count + 1, last_reminded_at = NOW()
     WHERE user_id = $1 AND reminder_type = $2 AND date = CURRENT_DATE`,
    [userId, reminderType]
  );
}

/**
 * Check whether a reminder was completed today.
 */
async function isCompleted(userId, reminderType) {
  const res = await query(
    `SELECT completed FROM reminder_state
     WHERE user_id = $1 AND reminder_type = $2 AND date = CURRENT_DATE`,
    [userId, reminderType]
  );
  return res.rows[0]?.completed === true;
}

/**
 * Check if user replied to food check within the last 45 minutes.
 */
async function recentFoodReply(userId) {
  const res = await query(
    `SELECT id FROM food_logs
     WHERE user_id = $1 AND logged_at > NOW() - INTERVAL '45 minutes'
     LIMIT 1`,
    [userId]
  );
  return res.rows.length > 0;
}

// ─── Weight Reminders ─────────────────────────────────────────────────────────

/**
 * Send first weight reminder or escalate for a user.
 * Fires at 7:00 AM IST (1:30 AM UTC) Mon/Wed/Fri.
 */
async function fireWeightReminder(whatsappNumber, role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;

    const state = await getOrCreateReminderState(user.id, 'weight');
    if (state.completed) {
      console.log(`[Cron] Weight already logged for ${role} today, skipping.`);
      return;
    }

    const count = state.reminder_count;
    const message = WEIGHT_REMINDERS[Math.min(count, WEIGHT_REMINDERS.length - 1)];

    console.log(`[Cron] Sending weight reminder #${count + 1} to ${role}`);
    await sendMessage(whatsappNumber, message);
    await bumpReminderCount(user.id, 'weight');

    // After 4 missed reminders, alert Aarav
    if (count >= 4) {
      const name = role.charAt(0).toUpperCase() + role.slice(1);
      await sendMessage(
        AARAV,
        `🚨 ${name} hasn't logged her weight today. She's ignored 4 reminders.`
      );
    }
  } catch (err) {
    console.error(`[Cron] Weight reminder error for ${role}:`, err.message);
  }
}

// ─── Walk Reminders ───────────────────────────────────────────────────────────

/**
 * 9:00 PM IST — first walk reminder.
 */
async function fireWalkReminder(whatsappNumber, role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;

    await getOrCreateReminderState(user.id, 'walk');
    if (await isCompleted(user.id, 'walk')) {
      console.log(`[Cron] Walk already confirmed for ${role} today.`);
      return;
    }

    console.log(`[Cron] Sending walk reminder to ${role}`);
    await sendMessage(
      whatsappNumber,
      `🚶‍♀️ Evening walk time! Have you walked today?\nReply 'done' when you've finished your walk 🌙`
    );
    await bumpReminderCount(user.id, 'walk');
  } catch (err) {
    console.error(`[Cron] Walk reminder error for ${role}:`, err.message);
  }
}

/**
 * 9:45 PM IST — second walk nudge.
 */
async function fireWalkFollowUp(whatsappNumber, role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;

    if (await isCompleted(user.id, 'walk')) return;

    console.log(`[Cron] Sending walk follow-up to ${role}`);
    await sendMessage(
      whatsappNumber,
      `🚶‍♀️ Still waiting! Did you walk? Reply 'done' or 'skipped'`
    );
    await bumpReminderCount(user.id, 'walk');
  } catch (err) {
    console.error(`[Cron] Walk follow-up error for ${role}:`, err.message);
  }
}

/**
 * 10:30 PM IST — alert Aarav if walk not confirmed.
 */
async function fireWalkAlert(role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;

    if (await isCompleted(user.id, 'walk')) return;

    const name = role.charAt(0).toUpperCase() + role.slice(1);
    console.log(`[Cron] Alerting Aarav: ${name} didn't confirm walk.`);
    await sendMessage(AARAV, `🚨 ${name} didn't confirm her evening walk tonight.`);
  } catch (err) {
    console.error(`[Cron] Walk alert error for ${role}:`, err.message);
  }
}

// ─── Trainer Reminders ────────────────────────────────────────────────────────

/**
 * 8:00 AM IST — first trainer reminder. Mon/Wed/Fri only (for mom).
 */
async function fireTrainerReminder(whatsappNumber, role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;

    await getOrCreateReminderState(user.id, 'trainer');
    if (await isCompleted(user.id, 'trainer')) return;

    console.log(`[Cron] Sending trainer reminder to ${role}`);
    await sendMessage(
      whatsappNumber,
      `💪 Trainer day! Did you complete your session today?\nReply 'done' when finished!`
    );
    await bumpReminderCount(user.id, 'trainer');
  } catch (err) {
    console.error(`[Cron] Trainer reminder error for ${role}:`, err.message);
  }
}

/**
 * 11:00 AM IST — second trainer nudge.
 */
async function fireTrainerFollowUp(whatsappNumber, role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;

    if (await isCompleted(user.id, 'trainer')) return;

    console.log(`[Cron] Sending trainer follow-up to ${role}`);
    await sendMessage(
      whatsappNumber,
      `💪 Still waiting for trainer confirmation! Did you work out? Reply 'done'`
    );
    await bumpReminderCount(user.id, 'trainer');
  } catch (err) {
    console.error(`[Cron] Trainer follow-up error for ${role}:`, err.message);
  }
}

/**
 * 1:00 PM IST — alert Aarav if trainer session not confirmed.
 */
async function fireTrainerAlert(role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;

    if (await isCompleted(user.id, 'trainer')) return;

    const name = role.charAt(0).toUpperCase() + role.slice(1);
    console.log(`[Cron] Alerting Aarav: ${name} hasn't confirmed trainer.`);
    await sendMessage(AARAV, `🚨 ${name} hasn't confirmed her trainer session today.`);
  } catch (err) {
    console.error(`[Cron] Trainer alert error for ${role}:`, err.message);
  }
}

// ─── Food Check-ins ───────────────────────────────────────────────────────────

/**
 * Hourly food check-in. Skips if user replied within the last 45 minutes.
 */
async function fireFoodCheckIn(whatsappNumber, role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;

    // Skip if they replied to food within the last 45 min
    const recentReply = await recentFoodReply(user.id);
    if (recentReply) {
      console.log(`[Cron] Food: ${role} replied recently, skipping.`);
      return;
    }

    console.log(`[Cron] Sending food check-in to ${role}`);
    await sendMessage(
      whatsappNumber,
      `🍽️ Food check! Did you eat anything in the last hour?\nReply with what you ate or send a photo 📸\n(Reply 'nothing' if you haven't eaten)`
    );
    await getOrCreateReminderState(user.id, 'food');
    await bumpReminderCount(user.id, 'food');
  } catch (err) {
    console.error(`[Cron] Food check-in error for ${role}:`, err.message);
  }
}

// ─── Schedule All Crons ───────────────────────────────────────────────────────

/**
 * Initialize and start all cron jobs.
 * All times stored as UTC. IST = UTC+5:30.
 *
 * IST → UTC reference:
 *   7:00 AM IST  = 1:30 AM UTC   → '30 1 * * *'
 *   7:30 AM IST  = 2:00 AM UTC   → '0 2 * * *'
 *   8:00 AM IST  = 2:30 AM UTC   → '30 2 * * *'
 *   9:00 AM IST  = 3:30 AM UTC   → '30 3 * * *'
 *   11:00 AM IST = 5:30 AM UTC   → '30 5 * * *'
 *   1:00 PM IST  = 7:30 AM UTC   → '30 7 * * *'
 *   8:00 PM IST  = 2:30 PM UTC   → '30 14 * * *'
 *   9:00 PM IST  = 3:30 PM UTC   → '30 15 * * *'
 *   9:45 PM IST  = 4:15 PM UTC   → '15 16 * * *'
 *   10:30 PM IST = 5:00 PM UTC   → '0 17 * * *'
 *   Hourly 8AM-10PM IST = 2:30AM-4:30PM UTC
 */
function initCrons() {
  console.log('[Cron] Initializing all cron jobs...');

  // ── Mom Weight: Mon/Wed/Fri only, every 30 min from 7 AM IST ──────────────
  // 7:00 AM IST = 1:30 AM UTC
  cron.schedule('30 1 * * 1,3,5', () => {
    console.log('[Cron] Mom weight first reminder');
    fireWeightReminder(MOM, 'mom');
  });
  // Every 30 min after — 7:30, 8:00, 8:30, 9:00, 9:30 AM IST
  cron.schedule('0 2 * * 1,3,5', () => fireWeightReminder(MOM, 'mom'));   // 7:30 AM IST
  cron.schedule('30 2 * * 1,3,5', () => fireWeightReminder(MOM, 'mom')); // 8:00 AM IST
  cron.schedule('0 3 * * 1,3,5', () => fireWeightReminder(MOM, 'mom'));   // 8:30 AM IST
  cron.schedule('30 3 * * 1,3,5', () => fireWeightReminder(MOM, 'mom')); // 9:00 AM IST
  cron.schedule('0 4 * * 1,3,5', () => fireWeightReminder(MOM, 'mom'));   // 9:30 AM IST

  // ── Dad Weight: Mon/Wed/Fri only ──────────────────────────────────────────
  cron.schedule('30 1 * * 1,3,5', () => fireWeightReminder(DAD, 'dad'));
  cron.schedule('0 2 * * 1,3,5', () => fireWeightReminder(DAD, 'dad'));
  cron.schedule('30 2 * * 1,3,5', () => fireWeightReminder(DAD, 'dad'));
  cron.schedule('0 3 * * 1,3,5', () => fireWeightReminder(DAD, 'dad'));
  cron.schedule('30 3 * * 1,3,5', () => fireWeightReminder(DAD, 'dad'));
  cron.schedule('0 4 * * 1,3,5', () => fireWeightReminder(DAD, 'dad'));

  // ── Mom Trainer: Mon/Wed/Fri ───────────────────────────────────────────────
  // 8:00 AM IST = 2:30 AM UTC
  cron.schedule('30 2 * * 1,3,5', () => {
    console.log('[Cron] Mom trainer first reminder');
    fireTrainerReminder(MOM, 'mom');
  });
  // 11:00 AM IST = 5:30 AM UTC
  cron.schedule('30 5 * * 1,3,5', () => {
    console.log('[Cron] Mom trainer follow-up');
    fireTrainerFollowUp(MOM, 'mom');
  });
  // 1:00 PM IST = 7:30 AM UTC
  cron.schedule('30 7 * * 1,3,5', () => {
    console.log('[Cron] Mom trainer alert to Aarav');
    fireTrainerAlert('mom');
  });

  // ── Mom Walk: Every night ─────────────────────────────────────────────────
  // 9:00 PM IST = 3:30 PM UTC
  cron.schedule('30 15 * * *', () => {
    console.log('[Cron] Mom walk reminder');
    fireWalkReminder(MOM, 'mom');
  });
  // 9:45 PM IST = 4:15 PM UTC
  cron.schedule('15 16 * * *', () => {
    console.log('[Cron] Mom walk follow-up');
    fireWalkFollowUp(MOM, 'mom');
  });
  // 10:30 PM IST = 5:00 PM UTC
  cron.schedule('0 17 * * *', () => {
    console.log('[Cron] Mom walk alert to Aarav');
    fireWalkAlert('mom');
  });

  // ── Dad Walk: Every night ─────────────────────────────────────────────────
  cron.schedule('30 15 * * *', () => {
    console.log('[Cron] Dad walk reminder');
    fireWalkReminder(DAD, 'dad');
  });
  cron.schedule('15 16 * * *', () => fireWalkFollowUp(DAD, 'dad'));
  cron.schedule('0 17 * * *', () => fireWalkAlert('dad'));

  // ── Mom Food: Hourly 8 AM to 10 PM IST (2:30 AM to 4:30 PM UTC) ──────────
  // 8 AM IST = 2:30 UTC, 9 AM = 3:30, 10 AM = 4:30, ... 10 PM = 16:30 UTC
  const foodHoursUTC = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  for (const hr of foodHoursUTC) {
    cron.schedule(`30 ${hr} * * *`, () => fireFoodCheckIn(MOM, 'mom'));
  }

  // ── Dad Food: Hourly 8 AM to 10 PM IST ───────────────────────────────────
  for (const hr of foodHoursUTC) {
    cron.schedule(`30 ${hr} * * *`, () => fireFoodCheckIn(DAD, 'dad'));
  }

  console.log('[Cron] All cron jobs scheduled.');
}

module.exports = { initCrons };
