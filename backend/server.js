// server.js
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// --- Required env vars ---
const {
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_EMAIL,
  ZOHO_ACCOUNTS_BASE, // optional: https://accounts.zoho.com or https://accounts.zoho.eu
  USE_SMTP // optional flag; set to "true" to enable SMTP fallback
} = process.env;

if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN || !ZOHO_EMAIL) {
  console.error('❌ Missing required env vars. Please set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and ZOHO_EMAIL in your env');
  process.exit(1);
}

const app = express();
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:8080',
    'https://uwezolinkinitiative.org'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '100kb' }));

// utils
const ACCOUNTS_BASE = (ZOHO_ACCOUNTS_BASE && ZOHO_ACCOUNTS_BASE.replace(/\/$/, '')) || 'https://accounts.zoho.com';
function smtpHostFromAccountsBase(accountsBase) {
  if (!accountsBase) return 'smtp.zoho.com';
  const host = accountsBase.replace(/^https?:\/\//, '');
  if (host.includes('zoho.eu')) return 'smtp.zoho.eu';
  if (host.includes('zoho.in')) return 'smtp.zoho.in';
  return 'smtp.zoho.com';
}
const SMTP_HOST = smtpHostFromAccountsBase(ACCOUNTS_BASE);

// state
let currentAccess = { token: null, expiresAt: 0, apiDomain: null };
let smtpTransporter = null;

// fetch access token using refresh token
async function fetchAccessToken() {
  const url = `${ACCOUNTS_BASE}/oauth/v2/token`;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: ZOHO_REFRESH_TOKEN
  });

  const resp = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });

  console.log('--- TOKEN DATA ---');
  console.log(JSON.stringify(resp.data, null, 2));
  return resp.data;
}

// prepare SMTP transporter (optional)
async function prepareSmtpTransporterIfNeeded(accessToken) {
  if (smtpTransporter) return smtpTransporter;

  smtpTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
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
    console.log(`✅ SMTP transporter verified (host=${SMTP_HOST})`);
  } catch (err) {
    console.error('SMTP verify failed (non-fatal):', err?.message || err);
  }

  return smtpTransporter;
}

// ensure we have a valid access token in state
async function ensureAccessToken() {
  if (currentAccess.token && Date.now() < (currentAccess.expiresAt - 30 * 1000)) {
    return currentAccess;
  }

  const tokenData = await fetchAccessToken();
  currentAccess.token = tokenData.access_token;
  currentAccess.expiresAt = Date.now() + ((tokenData.expires_in || 3600) * 1000);
  currentAccess.apiDomain = tokenData.api_domain || currentAccess.apiDomain || 'https://www.zohoapis.com';

  return currentAccess;
}

// send via Zoho Mail REST API (primary)
async function sendViaZohoApi({ to, subject, text }) {
  await ensureAccessToken();
  const apiBase = currentAccess.apiDomain || 'https://www.zohoapis.com';
  const url = `${apiBase.replace(/\/$/, '')}/mail/v1/messages`;

  const payload = {
    fromAddress: ZOHO_EMAIL,
    toAddress: to,
    subject,
    content: text || ''
  };

  try {
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Zoho-oauthtoken ${currentAccess.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    console.log('Zoho API send succeeded:', resp.data);
    return resp.data;
  } catch (err) {
    console.error('--- API SEND ERROR ---');
    if (err.response) {
      console.error('status:', err.response.status);
      console.error('data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('error:', err.message || err);
    }
    throw err;
  }
}

// send via SMTP (optional fallback)
async function sendViaSmtp({ to, subject, text }) {
  await ensureAccessToken();
  await prepareSmtpTransporterIfNeeded(currentAccess.token);

  if (!smtpTransporter) throw new Error('SMTP transporter not available');

  const msg = {
    from: `"Uwezo Link" <${ZOHO_EMAIL}>`,
    to,
    subject,
    text
  };

  return smtpTransporter.sendMail(msg);
}

// background token refresh
setInterval(async () => {
  try {
    await ensureAccessToken();
  } catch (err) {
    console.error('Background token refresh failed:', err?.message || err);
  }
}, 30 * 1000);

// simple health
app.get('/', (req, res) => res.status(200).send('Uwezo Link server is running.'));

// webhook
app.post('/webhook', async (req, res) => {
  console.log(`[${new Date().toISOString()}] /webhook payload:`, JSON.stringify(req.body));

  const { 'form-name': formName, ...fields } = req.body;
  const to = 'uwezolinkinitiative@gmail.com';
  const subject = `New ${formName || 'form'} submission`;
  const text = JSON.stringify(fields, null, 2);

  // Primary: use API
  try {
    await sendViaZohoApi({ to, subject, text });
    console.log('📩 Sent via Zoho API');
    return res.status(200).json({ message: 'Form submitted successfully (API)' });
  } catch (apiErr) {
    console.error('API send failed, will try SMTP fallback if enabled:', apiErr?.message || apiErr);

    if (String(USE_SMTP).toLowerCase() === 'true') {
      try {
        await sendViaSmtp({ to, subject, text });
        console.log('📩 Sent via SMTP fallback');
        return res.status(200).json({ message: 'Form submitted successfully (SMTP fallback)' });
      } catch (smtpErr) {
        console.error('SMTP fallback failed:', smtpErr?.message || smtpErr, smtpErr?.response || '');
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
