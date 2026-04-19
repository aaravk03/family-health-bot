require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Valid image MIME types accepted by the Claude API
const VALID_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Fetch a Twilio-hosted image with Basic Auth and return { base64, contentType }.
 * Shared by both food analysis and outdoor verification.
 */
async function fetchTwilioImage(imageUrl) {
  const authHeader = 'Basic ' + Buffer.from(
    process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN
  ).toString('base64');

  const response = await fetch(imageUrl, { headers: { 'Authorization': authHeader } });
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');

  // Strip parameters (e.g. "; charset=utf-8") and fall back to jpeg if not recognised
  let contentType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!VALID_MEDIA_TYPES.includes(contentType)) contentType = 'image/jpeg';

  return { base64, contentType };
}

/**
 * Use Claude Vision to analyse a food photo.
 * Returns calories, health rating, food name, and a coaching message.
 *
 * @param {string} imageUrl - Twilio media URL
 * @returns {{ calories: number|null, health: string|null, food: string, coach: string }}
 */
async function estimateCaloriesFromImage(imageUrl) {
  try {
    const { base64, contentType } = await fetchTwilioImage(imageUrl);

    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: contentType, data: base64 }
          },
          {
            type: 'text',
            text: `Analyze this food photo. Provide:
1. What food you see
2. Estimated calories
3. Health rating: UNHEALTHY, MODERATE, or HEALTHY
4. Coaching message based on the rating

Reply in EXACTLY this format:
CALORIES: [number]
HEALTH: [UNHEALTHY/MODERATE/HEALTHY]
FOOD: [what you see, 1 line]
COACH: [your coaching message]

Coaching guidelines:
- UNHEALTHY (junk food, fried, processed, high sugar): Be direct but kind. Tell her this isn't good for her weight loss goals, explain why briefly, suggest a healthier alternative
- MODERATE (okay but not ideal): Acknowledge it's not bad but suggest improvements
- HEALTHY (vegetables, fruits, lean protein, whole grains): Be genuinely encouraging and enthusiastic`
          }
        ]
      }]
    });

    const text = message.content[0].text;
    console.log(`[Claude Vision] Raw result:\n${text}`);

    const caloriesMatch = text.match(/CALORIES:\s*(\d+)/);
    const healthMatch   = text.match(/HEALTH:\s*(UNHEALTHY|MODERATE|HEALTHY)/i);
    const foodMatch     = text.match(/FOOD:\s*([^\n]+)/);
    const coachMatch    = text.match(/COACH:\s*([\s\S]+?)(?:\n[A-Z]+:|$)/);

    return {
      calories: caloriesMatch ? parseInt(caloriesMatch[1]) : null,
      health:   healthMatch   ? healthMatch[1].toUpperCase() : null,
      food:     foodMatch     ? foodMatch[1].trim() : 'Food',
      coach:    coachMatch    ? coachMatch[1].trim() : '',
    };
  } catch (err) {
    console.error('[Claude Vision] Error:', err.message);
    return { calories: null, health: null, food: 'Food logged', coach: '' };
  }
}

/**
 * Use Claude to analyse a text food description.
 * Returns calories, health rating, and a coaching message.
 *
 * @param {string} description - Text description of the meal
 * @returns {{ calories: number|null, health: string|null, coach: string }}
 */
async function estimateCaloriesFromText(description) {
  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Analyze this food/meal: "${description}"

Reply in EXACTLY this format:
CALORIES: [number]
HEALTH: [UNHEALTHY/MODERATE/HEALTHY]
FOOD: [brief name/description, 1 line]
COACH: [your coaching message]

Coaching guidelines:
- UNHEALTHY (junk food, fried, processed, high sugar): Be direct but kind. Tell her this isn't good for her weight loss goals, explain why briefly, suggest a healthier alternative
- MODERATE (okay but not ideal): Acknowledge it's not bad but suggest improvements
- HEALTHY (vegetables, fruits, lean protein, whole grains): Be genuinely encouraging and enthusiastic`
      }]
    });

    const text = message.content[0].text;
    console.log(`[Claude Text] Raw result:\n${text}`);

    const caloriesMatch = text.match(/CALORIES:\s*(\d+)/);
    const healthMatch   = text.match(/HEALTH:\s*(UNHEALTHY|MODERATE|HEALTHY)/i);
    const foodMatch     = text.match(/FOOD:\s*([^\n]+)/);
    const coachMatch    = text.match(/COACH:\s*([\s\S]+?)(?:\n[A-Z]+:|$)/);

    return {
      calories: caloriesMatch ? parseInt(caloriesMatch[1]) : null,
      health:   healthMatch   ? healthMatch[1].toUpperCase() : null,
      food:     foodMatch     ? foodMatch[1].trim() : description,
      coach:    coachMatch    ? coachMatch[1].trim() : '',
    };
  } catch (err) {
    console.error('[Claude Text] Error:', err.message);
    return { calories: null, health: null, food: description, coach: '' };
  }
}

/**
 * Use Claude Vision to verify whether a photo was taken outdoors.
 * Returns true if outdoor, false if indoor or unverifiable.
 *
 * @param {string} imageUrl - Twilio media URL
 * @returns {boolean}
 */
async function verifyOutdoorPhoto(imageUrl) {
  try {
    const { base64, contentType } = await fetchTwilioImage(imageUrl);

    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: contentType, data: base64 }
          },
          {
            type: 'text',
            text: 'Is this photo taken outdoors/outside? Look for sky, street, trees, buildings, outdoor environment. Reply with only: OUTDOOR: YES or OUTDOOR: NO and a brief reason'
          }
        ]
      }]
    });

    const text = message.content[0].text;
    console.log(`[Claude Outdoor] Result: ${text}`);
    return /OUTDOOR:\s*YES/i.test(text);
  } catch (err) {
    console.error('[Claude Outdoor] Error:', err.message);
    // Fail safe — don't confirm walk if verification fails
    return false;
  }
}

module.exports = { estimateCaloriesFromImage, estimateCaloriesFromText, verifyOutdoorPhoto };
