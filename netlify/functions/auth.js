// KHABAR License Key + Admin Approval System
// Email notification → Admin approves → User auto-unlocks
const https = require('https');

let getStore;
try { ({ getStore } = require('@netlify/blobs')); } catch(e) { getStore = null; }

const ADMIN_EMAIL = 'kanishkarora200@gmail.com';
const DEFAULT_ADMIN_SECRET = 'KHABAR_ADMIN_2024_SECURE';

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

// ─── Helpers ───────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

function json(status, data) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(data) };
}

function html(status, body) {
  const page = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KHABAR Admin</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#060b16;color:#d8e3f0;font-family:'Inter',Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#0c1221;border:1px solid #1a2744;border-radius:20px;padding:40px;max-width:560px;width:100%;text-align:center}
.logo{font-size:28px;font-weight:800;letter-spacing:6px;background:linear-gradient(135deg,#00ccff,#b388ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:20px}
h2{font-size:22px;margin-bottom:8px}p{color:#526580;font-size:13px;line-height:1.8;margin:8px 0}
.key-badge{display:inline-block;background:rgba(0,204,255,.1);color:#00ccff;border:1px solid rgba(0,204,255,.3);padding:8px 16px;border-radius:8px;font-family:monospace;font-size:15px;font-weight:700;letter-spacing:2px;margin:12px 0}
.btn{display:inline-block;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:800;font-size:14px;letter-spacing:1px;margin:8px;transition:all .2s}
.btn:hover{transform:translateY(-2px);filter:brightness(1.1)}
.btn-approve{background:#00e676;color:#000;box-shadow:0 4px 20px rgba(0,230,118,.3)}
.btn-reject{background:#ff3355;color:#fff;box-shadow:0 4px 20px rgba(255,51,85,.2)}
.info{background:rgba(0,0,0,.3);border-radius:10px;padding:14px;margin-top:16px;font-size:11px;color:#526580;text-align:left;line-height:2}
.info b{color:#d8e3f0}
.status-approved{color:#00e676;font-size:48px;margin-bottom:8px}
.status-rejected{color:#ff3355;font-size:48px;margin-bottom:8px}
.pending-item{background:rgba(0,0,0,.2);border:1px solid #1a2744;border-radius:10px;padding:16px;margin:10px 0;text-align:left}
.pending-item .pk{color:#00ccff;font-family:monospace;font-weight:700;font-size:13px}
.pending-item .pu{color:#526580;font-size:10px;margin-top:4px}
.actions{margin-top:8px}
</style></head><body><div class="card"><div class="logo">KHABAR</div>${body}</div></body></html>`;
  return { statusCode: status, headers: { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' }, body: page };
}

// ─── Blob Store (persistent KV) ───────────────────
async function getApprovalStore() {
  if (!getStore) return null;
  try {
    return getStore('khabar-approvals');
  } catch(e) {
    console.error('Blob store error:', e);
    return null;
  }
}

async function getApproval(store, key) {
  if (!store) return null;
  try {
    const data = await store.get(key, { type: 'json' });
    return data;
  } catch(e) { return null; }
}

async function setApproval(store, key, data) {
  if (!store) return;
  try {
    await store.setJSON(key, data);
  } catch(e) { console.error('Blob set error:', e); }
}

// ─── Email via Resend ─────────────────────────────
function sendApprovalEmail(key, userInfo) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    console.log('⚠ RESEND_API_KEY not set. Skipping email. Approve manually via admin panel.');
    return Promise.resolve(null);
  }

  const siteUrl = process.env.URL || 'https://khabar-terminal.netlify.app';
  const secret = process.env.ADMIN_SECRET || DEFAULT_ADMIN_SECRET;
  const approveUrl = `${siteUrl}/.netlify/functions/auth?action=approve&key=${encodeURIComponent(key)}&secret=${encodeURIComponent(secret)}`;
  const rejectUrl = `${siteUrl}/.netlify/functions/auth?action=reject&key=${encodeURIComponent(key)}&secret=${encodeURIComponent(secret)}`;
  const panelUrl = `${siteUrl}/.netlify/functions/auth?action=panel&secret=${encodeURIComponent(secret)}`;

  const emailHtml = `
<div style="background:#060b16;padding:40px 20px;font-family:Arial,sans-serif">
  <div style="max-width:500px;margin:0 auto;background:#0c1221;border:1px solid #1a2744;border-radius:16px;padding:32px;text-align:center">
    <div style="font-size:24px;font-weight:800;letter-spacing:6px;color:#00ccff;margin-bottom:4px">KHABAR</div>
    <div style="font-size:10px;color:#526580;letter-spacing:3px;margin-bottom:24px">ACCESS REQUEST</div>

    <div style="font-size:16px;color:#d8e3f0;font-weight:700;margin-bottom:4px">New User Requesting Access</div>

    <div style="background:rgba(0,204,255,0.08);border:1px solid rgba(0,204,255,0.2);border-radius:8px;padding:10px 16px;margin:16px 0;display:inline-block">
      <span style="font-family:monospace;font-size:16px;font-weight:700;color:#00ccff;letter-spacing:2px">${key}</span>
    </div>

    <div style="color:#526580;font-size:12px;margin:12px 0;line-height:2">
      <b style="color:#d8e3f0">User:</b> ${userInfo.user || 'Unknown'}<br>
      <b style="color:#d8e3f0">Time:</b> ${userInfo.requestedAt}<br>
      <b style="color:#d8e3f0">Device:</b> ${(userInfo.userAgent || '').slice(0, 80)}<br>
      <b style="color:#d8e3f0">IP:</b> ${userInfo.ip || 'Unknown'}
    </div>

    <div style="margin:24px 0">
      <a href="${approveUrl}" style="display:inline-block;padding:14px 40px;background:#00e676;color:#000;border-radius:10px;text-decoration:none;font-weight:800;font-size:15px;letter-spacing:1px;margin:6px">✓ APPROVE</a>
      <a href="${rejectUrl}" style="display:inline-block;padding:14px 40px;background:#ff3355;color:#fff;border-radius:10px;text-decoration:none;font-weight:800;font-size:15px;letter-spacing:1px;margin:6px">✕ REJECT</a>
    </div>

    <div style="font-size:10px;color:#526580;margin-top:16px;border-top:1px solid #1a2744;padding-top:12px">
      <a href="${panelUrl}" style="color:#00ccff;text-decoration:none">View Admin Panel</a> &bull;
      User is waiting for your approval
    </div>
  </div>
</div>`;

  const payload = JSON.stringify({
    from: 'KHABAR Terminal <onboarding@resend.dev>',
    to: [ADMIN_EMAIL],
    subject: `🔔 KHABAR: Approve Access — ${key} (${userInfo.user || 'New User'})`,
    html: emailHtml
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.log('Email sent:', res.statusCode, body);
        resolve(res.statusCode < 300);
      });
    });
    req.on('error', (e) => { console.error('Email error:', e); resolve(false); });
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// ─── Main Handler ─────────────────────────────────
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const store = await getApprovalStore();
  const ADMIN_SECRET = process.env.ADMIN_SECRET || DEFAULT_ADMIN_SECRET;

  // ── GET requests (admin clicks from email / admin panel) ──
  if (event.httpMethod === 'GET') {
    const p = event.queryStringParameters || {};

    // Approve
    if (p.action === 'approve' && p.key && p.secret === ADMIN_SECRET) {
      const key = p.key.toUpperCase().trim();
      const entry = VALID_KEYS[key];
      await setApproval(store, key, {
        status: 'approved',
        user: entry?.user || 'Unknown',
        approvedAt: new Date().toISOString()
      });
      return html(200, `
        <div class="status-approved">✓</div>
        <h2>Access Approved!</h2>
        <div class="key-badge">${key}</div>
        <p>${entry?.user || 'User'} can now access KHABAR Terminal.<br>Their screen will auto-unlock within 5 seconds.</p>
      `);
    }

    // Reject
    if (p.action === 'reject' && p.key && p.secret === ADMIN_SECRET) {
      const key = p.key.toUpperCase().trim();
      await setApproval(store, key, {
        status: 'rejected',
        rejectedAt: new Date().toISOString()
      });
      return html(200, `
        <div class="status-rejected">✕</div>
        <h2>Access Rejected</h2>
        <div class="key-badge">${key}</div>
        <p>User has been denied access to KHABAR Terminal.</p>
      `);
    }

    // Admin Panel
    if (p.action === 'panel' && p.secret === ADMIN_SECRET) {
      let items = '';
      let pendingCount = 0;
      for (const k of Object.keys(VALID_KEYS)) {
        const data = await getApproval(store, k);
        const status = data?.status || 'unused';
        let statusBadge = '';
        let actions = '';

        if (status === 'approved') {
          statusBadge = '<span style="color:#00e676;font-weight:700">✓ APPROVED</span>';
          actions = `<a href="?action=reject&key=${k}&secret=${encodeURIComponent(ADMIN_SECRET)}" class="btn btn-reject" style="padding:6px 14px;font-size:10px">Revoke</a>`;
        } else if (status === 'rejected') {
          statusBadge = '<span style="color:#ff3355;font-weight:700">✕ REJECTED</span>';
          actions = `<a href="?action=approve&key=${k}&secret=${encodeURIComponent(ADMIN_SECRET)}" class="btn btn-approve" style="padding:6px 14px;font-size:10px">Approve</a>`;
        } else if (status === 'pending') {
          statusBadge = '<span style="color:#ffc107;font-weight:700;animation:pulse 1.5s infinite">⏳ PENDING</span>';
          pendingCount++;
          actions = `
            <a href="?action=approve&key=${k}&secret=${encodeURIComponent(ADMIN_SECRET)}" class="btn btn-approve" style="padding:6px 14px;font-size:10px">Approve</a>
            <a href="?action=reject&key=${k}&secret=${encodeURIComponent(ADMIN_SECRET)}" class="btn btn-reject" style="padding:6px 14px;font-size:10px">Reject</a>
          `;
        } else {
          statusBadge = '<span style="color:#526580">— Not Used</span>';
        }

        items += `
          <div class="pending-item">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <div class="pk">${k}</div>
                <div class="pu">${VALID_KEYS[k].user}${data?.requestedAt ? ' &bull; Requested: ' + new Date(data.requestedAt).toLocaleString('en-IN') : ''}${data?.approvedAt ? ' &bull; Approved: ' + new Date(data.approvedAt).toLocaleString('en-IN') : ''}</div>
              </div>
              ${statusBadge}
            </div>
            <div class="actions">${actions}</div>
          </div>
        `;
      }

      return html(200, `
        <h2>Admin Panel</h2>
        <p>${pendingCount > 0 ? '<span style="color:#ffc107;font-weight:700">' + pendingCount + ' pending approval(s)</span>' : 'No pending requests'} &bull; ${Object.keys(VALID_KEYS).length} total keys</p>
        ${items}
        <div style="margin-top:20px;font-size:10px;color:#526580">
          Bookmark this page for quick access<br>
          <a href="?action=panel&secret=${encodeURIComponent(ADMIN_SECRET)}" style="color:#00ccff;text-decoration:none">↻ Refresh Panel</a>
        </div>
      `);
    }

    // Bad GET request
    if (p.action && p.secret !== ADMIN_SECRET) {
      return html(403, `
        <div class="status-rejected">🔒</div>
        <h2>Unauthorized</h2>
        <p>Invalid admin secret. Access denied.</p>
      `);
    }

    return html(404, '<h2>Not Found</h2>');
  }

  // ── POST requests (client-side JS) ──
  try {
    const body = JSON.parse(event.body || '{}');
    const { action, key } = body;
    const upper = (key || '').toUpperCase().trim();

    // VALIDATE — check key + approval status
    if (action === 'validate') {
      if (!upper) return json(400, { valid: false, error: 'No key provided' });

      const entry = VALID_KEYS[upper];
      if (!entry) return json(401, { valid: false, error: 'Invalid license key' });
      if (!entry.active) return json(403, { valid: false, error: 'This key has been deactivated' });

      // Check approval status in blob store
      const approval = await getApproval(store, upper);

      if (approval?.status === 'approved') {
        return json(200, { valid: true, approved: true, user: entry.user, plan: 'LIFETIME PRO', message: 'Welcome to KHABAR Terminal' });
      }

      if (approval?.status === 'rejected') {
        return json(403, { valid: true, approved: false, rejected: true, error: 'Access rejected by admin' });
      }

      if (approval?.status === 'pending') {
        return json(200, { valid: true, approved: false, status: 'pending', message: 'Waiting for admin approval...' });
      }

      // NEW REQUEST — first time this key is being used
      const requestInfo = {
        status: 'pending',
        key: upper,
        user: entry.user,
        requestedAt: new Date().toISOString(),
        userAgent: event.headers['user-agent'] || 'Unknown',
        ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'Unknown'
      };

      await setApproval(store, upper, requestInfo);

      // Send email to admin
      const emailSent = await sendApprovalEmail(upper, requestInfo);

      return json(200, {
        valid: true,
        approved: false,
        status: 'pending',
        emailSent: !!emailSent,
        message: emailSent ? 'Approval request sent to admin' : 'Request registered. Admin will approve shortly.'
      });
    }

    // CHECK — poll for approval status
    if (action === 'check') {
      if (!upper) return json(400, { approved: false, error: 'No key' });

      const approval = await getApproval(store, upper);

      if (approval?.status === 'approved') {
        return json(200, { approved: true, user: VALID_KEYS[upper]?.user || '', plan: 'LIFETIME PRO' });
      }
      if (approval?.status === 'rejected') {
        return json(200, { approved: false, rejected: true });
      }
      return json(200, { approved: false, status: approval?.status || 'unknown' });
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
