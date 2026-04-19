require('dotenv').config();
const { Pool } = require('pg');

// Create a connection pool to PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Railway hosted PostgreSQL
});

/**
 * Run a query against the database.
 * Returns rows from the result.
 */
async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
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
      whatsapp TEXT NOT NULL UNIQUE,
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

  // Update existing users by role (handles number changes on restart)
  await query(`UPDATE users SET whatsapp = $1 WHERE role = 'mom'`,   [process.env.MOM_WHATSAPP]);
  await query(`UPDATE users SET whatsapp = $1 WHERE role = 'dad'`,   [process.env.DAD_WHATSAPP]);
  await query(`UPDATE users SET whatsapp = $1 WHERE role = 'admin'`, [process.env.AARAV_WHATSAPP]);

  // Insert only if the role doesn't exist yet (first-time setup)
  await query(`INSERT INTO users (name, whatsapp, role) SELECT 'Mom', $1, 'mom' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'mom')`,   [process.env.MOM_WHATSAPP]);
  await query(`INSERT INTO users (name, whatsapp, role) SELECT 'Dad', $1, 'dad' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'dad')`,   [process.env.DAD_WHATSAPP]);
  await query(`INSERT INTO users (name, whatsapp, role) SELECT 'Aarav', $1, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`, [process.env.AARAV_WHATSAPP]);

  console.log('[DB] Seed users ready.');
}

module.exports = { query, initDB };
