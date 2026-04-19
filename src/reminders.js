require('dotenv').config();
const cron = require('node-cron');
const { query } = require('./db');
const { sendMessage } = require('./twilio');

// WhatsApp numbers from env
const MOM   = process.env.MOM_WHATSAPP;
const DAD   = process.env.DAD_WHATSAPP;
const AARAV = process.env.AARAV_WHATSAPP;

// ─── IST → UTC Conversion Reference (IST = UTC + 5:30) ───────────────────────
//
//  Weight reminders — Mon/Wed/Fri only (cron days 1,3,5):
//    7:00 AM IST = 01:30 UTC  →  '30 1 * * 1,3,5'
//    7:30 AM IST = 02:00 UTC  →  '0 2 * * 1,3,5'
//    8:00 AM IST = 02:30 UTC  →  '30 2 * * 1,3,5'
//    8:30 AM IST = 03:00 UTC  →  '0 3 * * 1,3,5'
//    9:00 AM IST = 03:30 UTC  →  '30 3 * * 1,3,5'
//    9:30 AM IST = 04:00 UTC  →  '0 4 * * 1,3,5'
//
//  Trainer reminders — Mon/Wed/Fri only:
//    8:00 AM IST = 02:30 UTC  →  '30 2 * * 1,3,5'
//   11:00 AM IST = 05:30 UTC  →  '30 5 * * 1,3,5'
//    1:00 PM IST = 07:30 UTC  →  '30 7 * * 1,3,5'
//
//  Walk reminders — every day:
//    7:00 PM IST = 13:30 UTC  →  '30 13 * * *'
//    7:30 PM IST = 14:00 UTC  →  '0 14 * * *'
//    8:00 PM IST = 14:30 UTC  →  '30 14 * * *'
//    8:30 PM IST = 15:00 UTC  →  '0 15 * * *'
//    9:00 PM IST = 15:30 UTC  →  '30 15 * * *'
//    9:30 PM IST = 16:00 UTC  →  '0 16 * * *'
//   10:00 PM IST = 16:30 UTC  →  '30 16 * * *'
//   10:30 PM IST = 17:00 UTC  →  '0 17 * * *'
//   11:00 PM IST = 17:30 UTC  →  '30 17 * * *'
//
//  Food check-ins — every day, every 2 hours:
//    8:00 AM IST = 02:30 UTC  →  '30 2 * * *'
//   10:00 AM IST = 04:30 UTC  →  '30 4 * * *'
//   12:00 PM IST = 06:30 UTC  →  '30 6 * * *'
//    2:00 PM IST = 08:30 UTC  →  '30 8 * * *'
//    4:00 PM IST = 10:30 UTC  →  '30 10 * * *'
//    6:00 PM IST = 12:30 UTC  →  '30 12 * * *'
//    8:00 PM IST = 14:30 UTC  →  '30 14 * * *'
//   10:00 PM IST = 16:30 UTC  →  '30 16 * * *'
//
//  End-of-day calorie summary (mom) — every day:
//   10:00 PM IST = 16:30 UTC  →  '30 16 * * *'  (same minute as last food check-in)

// ─── DB Helpers ───────────────────────────────────────────────────────────────

/** Get a user row by role ('mom', 'dad', 'admin'). */
async function getUserByRole(role) {
  const res = await query('SELECT * FROM users WHERE role = $1', [role]);
  return res.rows[0] || null;
}

/** Upsert a reminder_state row for today and return it. */
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

/** Increment reminder_count and stamp last_reminded_at. */
async function bumpReminderCount(userId, reminderType) {
  await query(
    `UPDATE reminder_state
     SET reminder_count = reminder_count + 1, last_reminded_at = NOW()
     WHERE user_id = $1 AND reminder_type = $2 AND date = CURRENT_DATE`,
    [userId, reminderType]
  );
}

/** Return true if the reminder was completed today. */
async function isCompleted(userId, reminderType) {
  const res = await query(
    `SELECT completed FROM reminder_state
     WHERE user_id = $1 AND reminder_type = $2 AND date = CURRENT_DATE`,
    [userId, reminderType]
  );
  return res.rows[0]?.completed === true;
}

/**
 * Return true if the user logged food within the last 90 minutes.
 * Used to skip redundant food check-ins.
 */
async function recentFoodReply(userId) {
  const res = await query(
    `SELECT id FROM food_logs
     WHERE user_id = $1 AND logged_at > NOW() - INTERVAL '90 minutes'
     LIMIT 1`,
    [userId]
  );
  return res.rows.length > 0;
}

/**
 * Return today's total logged calories for a user.
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

// ─── Generic Send Helpers ─────────────────────────────────────────────────────

/**
 * Send a weight reminder message if weight not yet logged today.
 */
async function sendWeightIfPending(whatsappNumber, role, message) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;
    const state = await getOrCreateReminderState(user.id, 'weight');
    if (state.completed) {
      console.log(`[Cron] Weight already logged for ${role}, skipping.`);
      return;
    }
    console.log(`[Cron] Sending weight reminder to ${role}`);
    await sendMessage(whatsappNumber, message);
    await bumpReminderCount(user.id, 'weight');
  } catch (err) {
    console.error(`[Cron] Weight reminder error for ${role}:`, err.message);
  }
}

/**
 * Send a walk reminder message if walk not yet confirmed today.
 */
async function sendWalkIfPending(whatsappNumber, role, message) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;
    await getOrCreateReminderState(user.id, 'walk');
    if (await isCompleted(user.id, 'walk')) {
      console.log(`[Cron] Walk already confirmed for ${role}, skipping.`);
      return;
    }
    console.log(`[Cron] Sending walk reminder to ${role}`);
    await sendMessage(whatsappNumber, message);
    await bumpReminderCount(user.id, 'walk');
  } catch (err) {
    console.error(`[Cron] Walk reminder error for ${role}:`, err.message);
  }
}

// ─── Weight Messages & Final Alert (Mom only — Mon/Wed/Fri) ──────────────────

const WEIGHT_MSGS = {
  '7:00am': `⚖️ Good morning! Weigh-in time 🌅\n\nRules:\n✅ AFTER using the bathroom (post-potty!)\n✅ BEFORE eating or drinking ANYTHING\n✅ No clothes if possible\n\nReply with your weight in kg (e.g. 68.2)`,
  '7:30am': `⚖️ Still waiting! Remember - post-potty, pre-food. Send your weight now 😤`,
  '8:00am': `😤 I'm not going away. WEIGHT. NOW. You know the rules - bathroom first, nothing to eat yet!`,
  '8:30am': `⚖️ This is reminder #4. Post-bathroom, before breakfast. Just send a number like 68.2 🙏`,
  '9:00am': `😠 Last chance before I tell Aarav! Send your weight RIGHT NOW. Post-potty. Pre-food. NOW.`,
};

/** 9:30 AM IST — alert Aarav if mom still hasn't logged weight. */
async function fireWeightFinalAlert() {
  try {
    const user = await getUserByRole('mom');
    if (!user) return;
    if (await isCompleted(user.id, 'weight')) return;
    console.log('[Cron] Mom weight — alerting Aarav (all reminders ignored)');
    await sendMessage(
      AARAV,
      `🚨 ALERT: Mom has not logged her weight this morning (Mon/Wed/Fri weigh-in). She ignored all reminders from 7am to 9:30am.`
    );
  } catch (err) {
    console.error('[Cron] Weight final alert error:', err.message);
  }
}

// ─── Trainer Reminders (Mom only — Mon/Wed/Fri) ───────────────────────────────

async function fireTrainerReminder(whatsappNumber, role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;
    await getOrCreateReminderState(user.id, 'trainer');
    if (await isCompleted(user.id, 'trainer')) return;
    console.log(`[Cron] Sending trainer reminder to ${role}`);
    await sendMessage(whatsappNumber, `💪 Trainer day! Did you complete your session today?\nReply 'done' when finished!`);
    await bumpReminderCount(user.id, 'trainer');
  } catch (err) {
    console.error(`[Cron] Trainer reminder error for ${role}:`, err.message);
  }
}

async function fireTrainerFollowUp(whatsappNumber, role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;
    if (await isCompleted(user.id, 'trainer')) return;
    console.log(`[Cron] Sending trainer follow-up to ${role}`);
    await sendMessage(whatsappNumber, `💪 Still waiting for trainer confirmation! Did you work out? Reply 'done'`);
    await bumpReminderCount(user.id, 'trainer');
  } catch (err) {
    console.error(`[Cron] Trainer follow-up error for ${role}:`, err.message);
  }
}

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

// ─── Walk Messages & Final Alert ──────────────────────────────────────────────

const WALK_MSGS = {
  '7:00pm':  `🚶‍♀️ Evening walk time! \n\nYou need to go outside and walk. When you're done, send me a photo taken OUTSIDE as proof 📸\n\nNo indoor photos accepted! Must show outside environment 🌳`,
  '7:30pm':  `🚶‍♀️ Still waiting for your walk proof! Go outside, walk, send a photo from OUTSIDE 🌳`,
  '8:00pm':  `😤 Walk. Outside. Photo. That's all I need. Go now!`,
  '8:30pm':  `🚶‍♀️ You have until 11pm. Go for your walk and send an outdoor photo as proof!`,
  '9:00pm':  `😠 Still no walk proof! Outside photo required. Not a home photo - OUTSIDE!`,
  '9:30pm':  `⚠️ Running out of time! Walk NOW and send outdoor photo before 11pm or I'm alerting Aarav`,
  '10:00pm': `😤 Final warnings. WALK. OUTSIDE. PHOTO. NOW.`,
  '10:30pm': `🚨 This is your last reminder. Walk outside now and send proof or Aarav gets notified at 11pm`,
};

/** 11:00 PM IST — alert Aarav if no outdoor walk photo received. */
async function fireWalkFinalAlert(role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;
    if (await isCompleted(user.id, 'walk')) return;
    const name = role.charAt(0).toUpperCase() + role.slice(1);
    console.log(`[Cron] Walk final alert — ${name} didn't complete walk.`);
    await sendMessage(
      AARAV,
      `🚨 ALERT: ${name} did not complete her evening walk today. No outdoor photo received between 7pm-11pm.`
    );
  } catch (err) {
    console.error(`[Cron] Walk final alert error for ${role}:`, err.message);
  }
}

// ─── Food Check-ins (every 2 hours, 8 AM – 10 PM IST) ───────────────────────

/**
 * Fire a food check-in if the user hasn't replied in the last 90 minutes.
 */
async function fireFoodCheckIn(whatsappNumber, role) {
  try {
    const user = await getUserByRole(role);
    if (!user) return;
    if (await recentFoodReply(user.id)) {
      console.log(`[Cron] Food: ${role} replied recently, skipping.`);
      return;
    }
    console.log(`[Cron] Sending food check-in to ${role}`);
    await sendMessage(
      whatsappNumber,
      `🍽️ Food check! What did you eat in the last 2 hours?\n\nSend a photo of your food 📸 or describe what you ate.\n(Reply 'nothing' if you haven't eaten)`
    );
    await getOrCreateReminderState(user.id, 'food');
    await bumpReminderCount(user.id, 'food');
  } catch (err) {
    console.error(`[Cron] Food check-in error for ${role}:`, err.message);
  }
}

// ─── Daily Calorie Summary (Mom — 10:00 PM IST) ──────────────────────────────

/**
 * Send mom a personalised end-of-day calorie summary.
 * Fires at 10:00 PM IST (16:30 UTC) — same minute as the last food check-in,
 * runs independently as its own cron.
 */
async function fireDailySummary() {
  try {
    const user = await getUserByRole('mom');
    if (!user) return;

    const total     = await getTodayCalorieTotal(user.id);
    const remaining = 1200 - total;

    let message;

    if (total === 0) {
      message =
        `⚠️ Daily Summary: No food was logged today. Please make sure you're logging your meals so we can track your progress!`;
    } else if (total >= 1200) {
      message =
        `🚨 Daily Summary: You consumed ~${total} calories today, which is over your 1200 limit.\n` +
        `Tomorrow, try to:\n` +
        `- Avoid fried/processed food\n` +
        `- Eat more vegetables and protein\n` +
        `- Drink more water\n` +
        `Keep going - every day is a new chance! 💪`;
    } else if (total >= 900) {
      message =
        `✅ Daily Summary: Great job today! You had ~${total} calories, staying within your 1200 limit.\n` +
        `${remaining} calories under budget 🌟\n` +
        `Keep this up!`;
    } else {
      // total < 900
      message =
        `⚠️ Daily Summary: You only logged ~${total} calories today. Make sure you're eating enough - 1200 is a healthy minimum.\n` +
        `Either eat a little more or make sure you're logging all your meals!`;
    }

    console.log(`[Cron] Sending daily calorie summary to mom (total: ${total} kcal)`);
    await sendMessage(MOM, message);
  } catch (err) {
    console.error('[Cron] Daily summary error:', err.message);
  }
}

// ─── Schedule All Crons ───────────────────────────────────────────────────────

function initCrons() {
  console.log('[Cron] Initializing all cron jobs...');

  // ── Mom Weight: Mon/Wed/Fri — specific message per 30-min slot ────────────
  //  7:00 AM IST = '30 1 * * 1,3,5'
  cron.schedule('30 1 * * 1,3,5', () => sendWeightIfPending(MOM, 'mom', WEIGHT_MSGS['7:00am']));
  //  7:30 AM IST = '0 2 * * 1,3,5'
  cron.schedule('0 2 * * 1,3,5',  () => sendWeightIfPending(MOM, 'mom', WEIGHT_MSGS['7:30am']));
  //  8:00 AM IST = '30 2 * * 1,3,5'
  cron.schedule('30 2 * * 1,3,5', () => sendWeightIfPending(MOM, 'mom', WEIGHT_MSGS['8:00am']));
  //  8:30 AM IST = '0 3 * * 1,3,5'
  cron.schedule('0 3 * * 1,3,5',  () => sendWeightIfPending(MOM, 'mom', WEIGHT_MSGS['8:30am']));
  //  9:00 AM IST = '30 3 * * 1,3,5'
  cron.schedule('30 3 * * 1,3,5', () => sendWeightIfPending(MOM, 'mom', WEIGHT_MSGS['9:00am']));
  //  9:30 AM IST = '0 4 * * 1,3,5' → alert Aarav
  cron.schedule('0 4 * * 1,3,5',  () => fireWeightFinalAlert());

  // ── Mom Trainer: Mon/Wed/Fri ───────────────────────────────────────────────
  //  8:00 AM IST = '30 2 * * 1,3,5'
  cron.schedule('30 2 * * 1,3,5', () => fireTrainerReminder(MOM, 'mom'));
  // 11:00 AM IST = '30 5 * * 1,3,5'
  cron.schedule('30 5 * * 1,3,5', () => fireTrainerFollowUp(MOM, 'mom'));
  //  1:00 PM IST = '30 7 * * 1,3,5' → alert Aarav
  cron.schedule('30 7 * * 1,3,5', () => fireTrainerAlert('mom'));

  // ── Mom Walk: Every night, 7 PM – 11 PM IST ───────────────────────────────
  cron.schedule('30 13 * * *', () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['7:00pm']));  //  7:00 PM IST
  cron.schedule('0 14 * * *',  () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['7:30pm']));  //  7:30 PM IST
  cron.schedule('30 14 * * *', () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['8:00pm']));  //  8:00 PM IST
  cron.schedule('0 15 * * *',  () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['8:30pm']));  //  8:30 PM IST
  cron.schedule('30 15 * * *', () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['9:00pm']));  //  9:00 PM IST
  cron.schedule('0 16 * * *',  () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['9:30pm']));  //  9:30 PM IST
  cron.schedule('30 16 * * *', () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['10:00pm'])); // 10:00 PM IST
  cron.schedule('0 17 * * *',  () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['10:30pm'])); // 10:30 PM IST
  cron.schedule('30 17 * * *', () => fireWalkFinalAlert('mom'));                            // 11:00 PM IST → Aarav

  // ── Dad Walk: Same schedule as Mom ────────────────────────────────────────
  cron.schedule('30 13 * * *', () => sendWalkIfPending(DAD, 'dad', WALK_MSGS['7:00pm']));
  cron.schedule('0 14 * * *',  () => sendWalkIfPending(DAD, 'dad', WALK_MSGS['7:30pm']));
  cron.schedule('30 14 * * *', () => sendWalkIfPending(DAD, 'dad', WALK_MSGS['8:00pm']));
  cron.schedule('0 15 * * *',  () => sendWalkIfPending(DAD, 'dad', WALK_MSGS['8:30pm']));
  cron.schedule('30 15 * * *', () => sendWalkIfPending(DAD, 'dad', WALK_MSGS['9:00pm']));
  cron.schedule('0 16 * * *',  () => sendWalkIfPending(DAD, 'dad', WALK_MSGS['9:30pm']));
  cron.schedule('30 16 * * *', () => sendWalkIfPending(DAD, 'dad', WALK_MSGS['10:00pm']));
  cron.schedule('0 17 * * *',  () => sendWalkIfPending(DAD, 'dad', WALK_MSGS['10:30pm']));
  cron.schedule('30 17 * * *', () => fireWalkFinalAlert('dad'));

  // ── Mom Food: Every 2 hours, 8 AM – 10 PM IST ────────────────────────────
  //  '30 2'  =  8:00 AM IST   '30 12' =  6:00 PM IST
  //  '30 4'  = 10:00 AM IST   '30 14' =  8:00 PM IST
  //  '30 6'  = 12:00 PM IST   '30 16' = 10:00 PM IST
  //  '30 8'  =  2:00 PM IST
  //  '30 10' =  4:00 PM IST
  const foodHoursUTC = [2, 4, 6, 8, 10, 12, 14, 16];
  for (const hr of foodHoursUTC) {
    cron.schedule(`30 ${hr} * * *`, () => fireFoodCheckIn(MOM, 'mom'));
  }

  // ── Dad Food: Same schedule ───────────────────────────────────────────────
  for (const hr of foodHoursUTC) {
    cron.schedule(`30 ${hr} * * *`, () => fireFoodCheckIn(DAD, 'dad'));
  }

  // ── Mom Daily Calorie Summary: 10:00 PM IST = '30 16 * * *' ──────────────
  // Fires at the same minute as the last food check-in but runs independently.
  cron.schedule('30 16 * * *', () => fireDailySummary());

  console.log('[Cron] All cron jobs scheduled.');
}

module.exports = { initCrons };
