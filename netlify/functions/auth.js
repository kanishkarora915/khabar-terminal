// KHABAR License Key Authentication
// 10 lifetime keys — server-side validation

const VALID_KEYS = {
  'KHABAR-PRO-8X2K9': { user: 'User 1', active: true },
  'KHABAR-PRO-4M7NW': { user: 'User 2', active: true },
  'KHABAR-PRO-6T3QP': { user: 'User 3', active: true },
  'KHABAR-PRO-9R5VJ': { user: 'User 4', active: true },
  'KHABAR-PRO-1Y8HC': { user: 'User 5', active: true },
  'KHABAR-PRO-3F6DL': { user: 'User 6', active: true },
  'KHABAR-PRO-7W2BS': { user: 'User 7', active: true },
  'KHABAR-PRO-5A9GT': { user: 'User 8', active: true },
  'KHABAR-PRO-2E4MR': { user: 'User 9', active: true },
  'KHABAR-PRO-0J1ZX': { user: 'User 10', active: true },
};

exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, key } = body;

    if (action === 'validate') {
      if (!key) return { statusCode: 400, headers: H, body: JSON.stringify({ valid: false, error: 'No key provided' }) };

      const upper = key.toUpperCase().trim();
      const entry = VALID_KEYS[upper];

      if (!entry) {
        return { statusCode: 401, headers: H, body: JSON.stringify({ valid: false, error: 'Invalid license key' }) };
      }

      if (!entry.active) {
        return { statusCode: 403, headers: H, body: JSON.stringify({ valid: false, error: 'This key has been deactivated' }) };
      }

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          valid: true,
          user: entry.user,
          key: upper,
          plan: 'LIFETIME PRO',
          message: 'Welcome to KHABAR Terminal'
        })
      };
    }

    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
