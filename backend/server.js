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

/** Exchange refresh token for access token */
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

/** Prepare SMTP transporter (optional fallback) */
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

/** Ensure we have a valid access token cached */
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

/**
 * sendViaZohoApi:
 * - discovers the Mail accountId using the Mail /api/accounts endpoint
 * - posts the message to /api/accounts/{accountId}/messages with the expected payload
 */
async function sendViaZohoApi({ to, subject, text }) {
  await ensureAccessToken();

  // Derive mail host from apiDomain (prefer mail.zoho.*)
  const apiDomain = currentAccess.apiDomain || 'https://www.zohoapis.com';
  let mailHost = 'https://mail.zoho.com';
  if (apiDomain.includes('.zohoapis.eu') || apiDomain.includes('zoho.eu')) mailHost = 'https://mail.zoho.eu';
  if (apiDomain.includes('.zohoapis.in') || apiDomain.includes('zoho.in')) mailHost = 'https://mail.zoho.in';

  // 1) Discover accounts
  let accountId = null;
  try {
    const accountsUrl = `${mailHost.replace(/\/$/, '')}/api/accounts`;
    const accountsResp = await axios.get(accountsUrl, {
      headers: { Authorization: `Zoho-oauthtoken ${currentAccess.token}` },
      timeout: 10000
    });

    console.log('Mail accounts response:', JSON.stringify(accountsResp.data, null, 2));
    const accounts = accountsResp.data?.data || accountsResp.data?.accounts || accountsResp.data;

    if (Array.isArray(accounts) && accounts.length > 0) {
      // Try to find a matching account by email
      const matching = accounts.find(a => {
        const emailCandidates = [
          a?.email,
          a?.account_name,
          a?.account,
          a?.accountId,
          a?.id
        ].filter(Boolean).map(s => String(s).toLowerCase());
        return emailCandidates.includes((ZOHO_EMAIL || '').toLowerCase());
      });
      const chosen = matching || accounts[0];
      accountId = chosen?.accountId || chosen?.id || chosen?.account_id || chosen?.account;
    } else if (accounts && typeof accounts === 'object') {
      accountId = accounts.accountId || accounts.id || accounts.account_id || accounts.account;
    }
  } catch (err) {
    console.error('Failed to discover Mail accounts:', err?.response?.data || err.message || err);
    throw new Error('Could not discover Zoho Mail accounts for this token (see logs).');
  }

  if (!accountId) {
    console.error('No accountId discovered from Zoho Mail accounts response.');
    throw new Error('No Zoho Mail accountId discovered for your account.');
  }

  // 2) Build account-scoped send URL
  const sendUrl = `${mailHost.replace(/\/$/, '')}/api/accounts/${encodeURIComponent(accountId)}/messages`;

  // 3) Build payload (message object with content array)
  const payload = {
    message: {
      subject,
      fromAddress: ZOHO_EMAIL,
      toAddress: to,
      content: [
        {
          type: 'text/plain',
          value: text || ''
        }
      ]
    }
  };

  // 4) POST the message
  try {
    const resp = await axios.post(sendUrl, payload, {
      headers: {
        Authorization: `Zoho-oauthtoken ${currentAccess.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    console.log('Zoho API send response:', JSON.stringify(resp.data, null, 2));
    return resp.data;
  } catch (err) {
    console.error('--- API SEND ERROR ---');
    if (err?.response) {
      console.error('status:', err.response.status);
      console.error('data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('error:', err.message || err);
    }
    throw err;
  }
}

/** Send via SMTP fallback (optional) */
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

// health
app.get('/', (req, res) => res.status(200).send('Uwezo Link server is running.'));

// webhook
app.post('/webhook', async (req, res) => {
  console.log(`[${new Date().toISOString()}] /webhook payload:`, JSON.stringify(req.body));

  const { 'form-name': formName, ...fields } = req.body;
  const to = 'uwezolinkinitiative@gmail.com';
  const subject = `New ${formName || 'form'} submission`;
  const text = JSON.stringify(fields, null, 2);

  // API-first
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
