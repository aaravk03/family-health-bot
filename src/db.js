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

  // Seed default users (insert if not already present)
  const seedUsers = [
    { name: 'Mom', whatsapp: process.env.MOM_WHATSAPP || 'whatsapp:+15109902052', role: 'mom' },
    { name: 'Dad', whatsapp: process.env.DAD_WHATSAPP || 'whatsapp:+15109902052', role: 'dad' },
    { name: 'Aarav', whatsapp: process.env.AARAV_WHATSAPP || 'whatsapp:+15109902052', role: 'admin' },
  ];

  for (const u of seedUsers) {
    await pool.query(
      `INSERT INTO users (name, whatsapp, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (whatsapp) DO NOTHING`,
      [u.name, u.whatsapp, u.role]
    );
  }

  console.log('[DB] Seed users ready.');
}

module.exports = { query, initDB };
