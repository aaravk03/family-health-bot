require('dotenv').config();
const { Pool } = require('pg');

// Create a connection pool to PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Railway hosted PostgreSQL
});

/**
 * Run a query against the database.
 * Returns the full pg result object.
 */
async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

/**
 * Seed users table, handling both first-run inserts and number updates.
 * Drops the unique constraint on whatsapp first so number changes never conflict.
 */
async function seedUsers() {
  // Remove the unique constraint so changing a whatsapp number never blocks startup
  await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_whatsapp_key`);

  // Mom
  const mom = await query(`SELECT id FROM users WHERE role = 'mom'`);
  if (mom.rows.length === 0) {
    await query(`INSERT INTO users (name, whatsapp, role) VALUES ('Mom', $1, 'mom')`, [process.env.MOM_WHATSAPP]);
  } else {
    await query(`UPDATE users SET whatsapp = $1 WHERE role = 'mom'`, [process.env.MOM_WHATSAPP]);
  }

  // Dad
  const dad = await query(`SELECT id FROM users WHERE role = 'dad'`);
  if (dad.rows.length === 0) {
    await query(`INSERT INTO users (name, whatsapp, role) VALUES ('Dad', $1, 'dad')`, [process.env.DAD_WHATSAPP]);
  } else {
    await query(`UPDATE users SET whatsapp = $1 WHERE role = 'dad'`, [process.env.DAD_WHATSAPP]);
  }

  // Admin (Aarav)
  const admin = await query(`SELECT id FROM users WHERE role = 'admin'`);
  if (admin.rows.length === 0) {
    await query(`INSERT INTO users (name, whatsapp, role) VALUES ('Aarav', $1, 'admin')`, [process.env.AARAV_WHATSAPP]);
  } else {
    await query(`UPDATE users SET whatsapp = $1 WHERE role = 'admin'`, [process.env.AARAV_WHATSAPP]);
  }

  console.log('[DB] Seed users ready.');
}

/**
 * Initialize the database schema and seed default users.
 * Called once on server startup.
 */
async function initDB() {
  console.log('[DB] Initializing schema...');

  // Create tables if they don't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS weight_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      weight_kg DECIMAL,
      logged_at TIMESTAMP DEFAULT NOW(),
      log_date DATE DEFAULT CURRENT_DATE
    );

    CREATE TABLE IF NOT EXISTS food_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      description TEXT,
      calories INTEGER,
      image_url TEXT,
      logged_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS walk_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      confirmed BOOLEAN DEFAULT TRUE,
      logged_at TIMESTAMP DEFAULT NOW(),
      log_date DATE DEFAULT CURRENT_DATE
    );

    CREATE TABLE IF NOT EXISTS trainer_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      confirmed BOOLEAN DEFAULT TRUE,
      logged_at TIMESTAMP DEFAULT NOW(),
      log_date DATE DEFAULT CURRENT_DATE
    );

    CREATE TABLE IF NOT EXISTS reminder_state (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      reminder_type TEXT NOT NULL,
      date DATE NOT NULL,
      completed BOOLEAN DEFAULT FALSE,
      reminder_count INTEGER DEFAULT 0,
      last_reminded_at TIMESTAMP,
      UNIQUE(user_id, reminder_type, date)
    );
  `);

  console.log('[DB] Schema ready.');

  // Drop the unique constraint on whatsapp and seed/update users
  await seedUsers();
}

module.exports = { query, initDB };
