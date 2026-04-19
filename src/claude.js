require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Use Claude Vision to estimate calories from a food photo.
 * Fetches the image, converts to base64, and sends to claude-opus-4-6.
 *
 * @param {string} imageUrl - Publicly accessible URL of the food photo (e.g. from Twilio)
 * @returns {{ calories: number|null, description: string, notes: string }}
 */
async function estimateCaloriesFromImage(imageUrl) {
  try {
    // Fetch image bytes and convert to base64
    const response = await fetch(imageUrl);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    let contentType = response.headers.get('content-type') || 'image/jpeg';
    // Ensure it's a valid Claude media type
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)) {
      contentType = 'image/jpeg';
    }
    // Strip any parameters like charset
    contentType = contentType.split(';')[0].trim();

    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: contentType, data: base64 }
          },
          {
            type: 'text',
            text: 'Look at this food/meal photo. Estimate the total calories. Reply in this exact format only: CALORIES: [number] | DESCRIPTION: [brief 1 line description of what you see] | NOTES: [any health notes in 5 words max]. If no food is visible, reply: CALORIES: 0 | DESCRIPTION: No food detected | NOTES: Please send a food photo'
          }
        ]
      }]
    });

    const text = message.content[0].text;
    const caloriesMatch = text.match(/CALORIES:\s*(\d+)/);
    const descMatch = text.match(/DESCRIPTION:\s*([^|]+)/);
    const notesMatch = text.match(/NOTES:\s*(.+)/);

    console.log(`[Claude Vision] Parsed result: ${text}`);

    return {
      calories: caloriesMatch ? parseInt(caloriesMatch[1]) : null,
      description: descMatch ? descMatch[1].trim() : 'Food logged',
      notes: notesMatch ? notesMatch[1].trim() : ''
    };
  } catch (err) {
    console.error('[Claude Vision] Error:', err.message);
    return { calories: null, description: 'Food logged', notes: '' };
  }
}

/**
 * Use Claude to estimate calories from a text food description.
 *
 * @param {string} description - Text description of the food/meal
 * @returns {{ calories: number|null, notes: string }}
 */
async function estimateCaloriesFromText(description) {
  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Estimate calories for this meal/food: "${description}". Reply in this exact format only: CALORIES: [number] | NOTES: [brief health note in 5 words max]`
      }]
    });

    const text = message.content[0].text;
    const caloriesMatch = text.match(/CALORIES:\s*(\d+)/);
    const notesMatch = text.match(/NOTES:\s*(.+)/);

    console.log(`[Claude Text] Parsed result: ${text}`);

    return {
      calories: caloriesMatch ? parseInt(caloriesMatch[1]) : null,
      notes: notesMatch ? notesMatch[1].trim() : ''
    };
  } catch (err) {
    console.error('[Claude Text] Error:', err.message);
    return { calories: null, notes: '' };
  }
}

module.exports = { estimateCaloriesFromImage, estimateCaloriesFromText };
