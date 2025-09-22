// server.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import nodemailer from 'nodemailer';
import cors from 'cors';

const {
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_EMAIL,
  ZOHO_ACCOUNT_ID,
  ZOHO_ACCOUNTS_BASE = 'https://accounts.zoho.com',
  USE_SMTP = 'false'
} = process.env;

if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN || !ZOHO_EMAIL || !ZOHO_ACCOUNT_ID) {
  console.error('❌ Missing required env vars. Please set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_EMAIL and ZOHO_ACCOUNT_ID.');
  process.exit(1);
}

const app = express();
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:8080',
    'https://uwezolinkinitiative.org'
  ],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '100kb' }));

// State for in-memory access token caching
let tokenState = {
  accessToken: null,
  expiresAt: 0,     // epoch ms
  apiDomain: 'https://mail.zoho.com' // default target for mail endpoints
};

// Exchange refresh token for access token
async function fetchAccessTokenUsingRefreshToken() {
  try {
    const url = `${ZOHO_ACCOUNTS_BASE.replace(/\/$/, '')}/oauth/v2/token`;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN
    });

    const resp = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
      validateStatus: () => true
    });

    if (resp.status !== 200) {
      console.error('Failed to exchange refresh token:', resp.status, resp.data);
      throw new Error(`Token exchange failed status ${resp.status}`);
    }

    const data = resp.data;
    // resp.data often includes api_domain for Zoho APIs
    tokenState.accessToken = data.access_token;
    tokenState.expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
    // prefer mail-specific domain if provided
    if (data.api_domain) {
      // mail API endpoints usually live under mail.zoho.com; however data.api_domain may be https://www.zohoapis.com
      // We'll use mail.zoho.com for sending because /api/accounts endpoints live there.
      tokenState.apiDomain = data.api_domain.includes('zohoapis') ? 'https://mail.zoho.com' : data.api_domain;
    }
    console.log(`🔁 Obtained Zoho access token — expires in ${data.expires_in || 3600}s`);
    return tokenState;
  } catch (err) {
    console.error('Error fetching Zoho access token:', err.response?.data || err.message || err);
    throw err;
  }
}

// Ensure we have a valid access token (cached)
async function ensureAccessToken() {
  // if token exists and not expiring in next 30s, reuse
  if (tokenState.accessToken && Date.now() < (tokenState.expiresAt - 30 * 1000)) {
    return tokenState;
  }
  return await fetchAccessTokenUsingRefreshToken();
}

// Primary send via Zoho Mail API (mail.zoho.com)
async function sendViaZohoApi({ to, subject, text }) {
  await ensureAccessToken();
  // Use mail.zoho.com API endpoint for accounts
  const apiBase = tokenState.apiDomain || 'https://mail.zoho.com';
  // endpoint: POST /api/accounts/{accountId}/messages
  const url = `${apiBase.replace(/\/$/, '')}/api/accounts/${ZOHO_ACCOUNT_ID}/messages`;

  // Zoho Mail API expects content objects; this structure is typical:
  const payload = {
    fromAddress: ZOHO_EMAIL,
    toAddress: to,
    subject,
    // content as array of { type, value } — plain text fallback included
    content: [
      { type: 'text/plain', value: text || '' }
    ]
  };

  try {
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Zoho-oauthtoken ${tokenState.accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true
    });

    // If Zoho returns HTML (error page) it will be string; log what we get
    if (typeof resp.data === 'string') {
      console.error('Zoho API returned non-JSON body (HTML?). Raw body:', resp.data.slice(0, 200));
    }

    if (resp.status >= 200 && resp.status < 300) {
      console.log('Zoho API send succeeded:', resp.data);
      return resp.data;
    }

    // non-2xx from Zoho
    console.error('Zoho API send error:', resp.status, resp.data);
    throw new Error(`Zoho API send failed ${resp.status}`);
  } catch (err) {
    console.error('sendViaZohoApi error:', err.response?.data || err.message || err);
    throw err;
  }
}

// Optional SMTP fallback using OAuth2 (if you want)
let smtpTransporter = null;
async function prepareSmtpTransporter(accessToken) {
  if (smtpTransporter) return smtpTransporter;

  // decide SMTP host (region)
  let smtpHost = 'smtp.zoho.com';
  if ((ZOHO_ACCOUNTS_BASE || '').includes('zoho.eu')) smtpHost = 'smtp.zoho.eu';
  if ((ZOHO_ACCOUNTS_BASE || '').includes('zoho.in')) smtpHost = 'smtp.zoho.in';

  smtpTransporter = nodemailer.createTransport({
    host: smtpHost,
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      type: 'OAuth2',
      user: ZOHO_EMAIL,
      clientId: ZOHO_CLIENT_ID,
      clientSecret: ZOHO_CLIENT_SECRET,
      refreshToken: ZOHO_REFRESH_TOKEN,
      accessToken: accessToken
    },
    authMethod: 'XOAUTH2'
  });

  try {
    await smtpTransporter.verify();
    console.log(`✅ SMTP transporter verified (host=${smtpHost})`);
  } catch (err) {
    console.error('SMTP verify failed (non-fatal):', err?.message || err);
    // keep transporter but don't assume it will work reliably
  }

  return smtpTransporter;
}

async function sendViaSmtp({ to, subject, text }) {
  await ensureAccessToken();
  await prepareSmtpTransporter(tokenState.accessToken);

  if (!smtpTransporter) throw new Error('SMTP transporter not available');

  const msg = {
    from: `"Uwezo Link" <${ZOHO_EMAIL}>`,
    to,
    subject,
    text
  };

  return smtpTransporter.sendMail(msg);
}

// Background refresh: refresh access token shortly before expiry
setInterval(async () => {
  try {
    if (!tokenState.expiresAt || Date.now() > (tokenState.expiresAt - 60 * 1000)) {
      console.log('Refreshing Zoho access token (background) ...');
      await fetchAccessTokenUsingRefreshToken();
    }
  } catch (err) {
    console.error('Background refresh failed:', err?.message || err);
  }
}, 30 * 1000); // check every 30s

// Health check
app.get('/', (req, res) => res.status(200).send('Uwezo Link server is running.'));

// Webhook: handle all forms
app.post('/webhook', async (req, res) => {
  console.log(`[${new Date().toISOString()}] /webhook payload:`, JSON.stringify(req.body));

  const { 'form-name': formName, ...fields } = req.body;
  const to = 'uwezolinkinitiative@gmail.com';
  const subject = `New ${formName || 'form'} submission`;
  const text = JSON.stringify(fields, null, 2);

  // Try API first
  try {
    await sendViaZohoApi({ to, subject, text });
    console.log('📩 Sent via Zoho Mail API');
    return res.status(200).json({ message: 'Form submitted successfully (API)' });
  } catch (apiErr) {
    console.error('API send failed:', apiErr?.message || apiErr);

    // optional SMTP fallback
    if (String(USE_SMTP).toLowerCase() === 'true') {
      try {
        await sendViaSmtp({ to, subject, text });
        console.log('📩 Sent via SMTP fallback');
        return res.status(200).json({ message: 'Form submitted successfully (SMTP fallback)' });
      } catch (smtpErr) {
        console.error('SMTP fallback failed:', smtpErr?.message || smtpErr);
        return res.status(500).json({ error: 'Failed to send email via API and SMTP' });
      }
    }

    return res.status(500).json({ error: 'Failed to send email via Zoho API' });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
