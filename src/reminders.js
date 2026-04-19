require('dotenv').config();
const cron = require('node-cron');
const { query } = require('./db');
const { sendMessage } = require('./twilio');

// WhatsApp numbers from env
const MOM   = process.env.MOM_WHATSAPP;
const DAD   = process.env.DAD_WHATSAPP;
const AARAV = process.env.AARAV_WHATSAPP;

// ─── IST → UTC conversion reference ──────────────────────────────────────────
//  7:00 AM IST = 01:30 UTC   8:30 AM IST = 03:00 UTC
//  7:30 AM IST = 02:00 UTC   9:00 AM IST = 03:30 UTC
//  8:00 AM IST = 02:30 UTC   9:30 AM IST = 04:00 UTC
//  7:00 PM IST = 13:30 UTC  10:00 PM IST = 16:30 UTC
//  7:30 PM IST = 14:00 UTC  10:30 PM IST = 17:00 UTC
//  8:00 PM IST = 14:30 UTC  11:00 PM IST = 17:30 UTC
//  8:30 PM IST = 15:00 UTC  11:00 AM IST = 05:30 UTC
//  9:00 PM IST = 15:30 UTC   1:00 PM IST = 07:30 UTC
//  9:30 PM IST = 16:00 UTC

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

// ─── Generic Send Helpers ─────────────────────────────────────────────────────

/**
 * Send a weight reminder message if not yet logged today.
 * @param {string} whatsappNumber
 * @param {string} role
 * @param {string} message
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
 * @param {string} whatsappNumber
 * @param {string} role
 * @param {string} message
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

// ─── Weight Reminders (Mom only — Mon / Wed / Fri) ────────────────────────────

const WEIGHT_MSGS = {
  '7:00': `⚖️ Good morning! Weigh-in time 🌅\n\nRules:\n✅ AFTER using the bathroom (post-potty!)\n✅ BEFORE eating or drinking ANYTHING\n✅ No clothes if possible\n\nReply with your weight in kg (e.g. 68.2)`,
  '7:30': `⚖️ Still waiting! Remember - post-potty, pre-food. Send your weight now 😤`,
  '8:00': `😤 I'm not going away. WEIGHT. NOW. You know the rules - bathroom first, nothing to eat yet!`,
  '8:30': `⚖️ This is reminder #4. Post-bathroom, before breakfast. Just send a number like 68.2 🙏`,
  '9:00': `😠 Last chance before I tell Aarav! Send your weight RIGHT NOW. Post-potty. Pre-food. NOW.`,
};

/**
 * 9:30 AM IST — final weight check: alert Aarav if still not logged.
 */
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

// ─── Trainer Reminders (Mom only — Mon / Wed / Fri) ───────────────────────────

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

// ─── Walk Messages ────────────────────────────────────────────────────────────

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

/**
 * 11:00 PM IST — alert Aarav if no outdoor walk photo received.
 */
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
    const recentReply = await recentFoodReply(user.id);
    if (recentReply) {
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

// ─── Schedule All Crons ───────────────────────────────────────────────────────

function initCrons() {
  console.log('[Cron] Initializing all cron jobs...');

  // ── Mom Weight: Mon/Wed/Fri — individual message per 30-min slot ───────────
  cron.schedule('30 1 * * 1,3,5', () => sendWeightIfPending(MOM, 'mom', WEIGHT_MSGS['7:00'])); // 7:00 AM IST
  cron.schedule('0 2 * * 1,3,5',  () => sendWeightIfPending(MOM, 'mom', WEIGHT_MSGS['7:30'])); // 7:30 AM IST
  cron.schedule('30 2 * * 1,3,5', () => sendWeightIfPending(MOM, 'mom', WEIGHT_MSGS['8:00'])); // 8:00 AM IST
  cron.schedule('0 3 * * 1,3,5',  () => sendWeightIfPending(MOM, 'mom', WEIGHT_MSGS['8:30'])); // 8:30 AM IST
  cron.schedule('30 3 * * 1,3,5', () => sendWeightIfPending(MOM, 'mom', WEIGHT_MSGS['9:00'])); // 9:00 AM IST
  cron.schedule('0 4 * * 1,3,5',  () => fireWeightFinalAlert());                               // 9:30 AM IST → alert Aarav

  // ── Mom Trainer: Mon/Wed/Fri ───────────────────────────────────────────────
  cron.schedule('30 2 * * 1,3,5', () => fireTrainerReminder(MOM, 'mom')); // 8:00 AM IST
  cron.schedule('30 5 * * 1,3,5', () => fireTrainerFollowUp(MOM, 'mom')); // 11:00 AM IST
  cron.schedule('30 7 * * 1,3,5', () => fireTrainerAlert('mom'));          // 1:00 PM IST

  // ── Mom Walk: Every night, 7 PM – 11 PM IST ───────────────────────────────
  cron.schedule('30 13 * * *', () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['7:00pm']));  // 7:00 PM IST
  cron.schedule('0 14 * * *',  () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['7:30pm']));  // 7:30 PM IST
  cron.schedule('30 14 * * *', () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['8:00pm']));  // 8:00 PM IST
  cron.schedule('0 15 * * *',  () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['8:30pm']));  // 8:30 PM IST
  cron.schedule('30 15 * * *', () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['9:00pm']));  // 9:00 PM IST
  cron.schedule('0 16 * * *',  () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['9:30pm']));  // 9:30 PM IST
  cron.schedule('30 16 * * *', () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['10:00pm'])); // 10:00 PM IST
  cron.schedule('0 17 * * *',  () => sendWalkIfPending(MOM, 'mom', WALK_MSGS['10:30pm'])); // 10:30 PM IST
  cron.schedule('30 17 * * *', () => fireWalkFinalAlert('mom'));                            // 11:00 PM IST → alert Aarav

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
  // 8am=02:30 UTC, 10am=04:30, 12pm=06:30, 2pm=08:30, 4pm=10:30, 6pm=12:30, 8pm=14:30, 10pm=16:30
  const foodHoursUTC = [2, 4, 6, 8, 10, 12, 14, 16];
  for (const hr of foodHoursUTC) {
    cron.schedule(`30 ${hr} * * *`, () => fireFoodCheckIn(MOM, 'mom'));
  }

  // ── Dad Food: Same schedule ───────────────────────────────────────────────
  for (const hr of foodHoursUTC) {
    cron.schedule(`30 ${hr} * * *`, () => fireFoodCheckIn(DAD, 'dad'));
  }

  console.log('[Cron] All cron jobs scheduled.');
}

module.exports = { initCrons };
