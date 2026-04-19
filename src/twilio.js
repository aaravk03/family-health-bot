require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

/**
 * Send a WhatsApp message via Twilio.
 * @param {string} to - Recipient's WhatsApp number (e.g. 'whatsapp:+1234567890')
 * @param {string} body - Message text to send
 */
async function sendMessage(to, body) {
  try {
    const message = await client.messages.create({
      from: FROM_NUMBER,
      to,
      body,
    });
    console.log(`[Twilio] Sent to ${to}: "${body.substring(0, 60)}..." | SID: ${message.sid}`);
    return message;
  } catch (err) {
    console.error(`[Twilio] Failed to send to ${to}:`, err.message);
    throw err;
  }
}

module.exports = { sendMessage };
