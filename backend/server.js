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
  ZOHO_ACCOUNTS_BASE // e.g. https://accounts.zoho.com or https://accounts.zoho.eu
} = process.env;

if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN || !ZOHO_EMAIL) {
  console.error('❌ Missing required env vars. Please set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and ZOHO_EMAIL in your env');
  process.exit(1);
}

const app = express();

// CORS
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

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Helper to derive smtp host from accounts base
function smtpHostFromAccountsBase(accountsBase) {
  if (!accountsBase) return 'smtp.zoho.com';
  const host = accountsBase.replace(/^https?:\/\//, '');
  if (host.includes('zoho.eu')) return 'smtp.zoho.eu';
  if (host.includes('zoho.in')) return 'smtp.zoho.in';
  return 'smtp.zoho.com';
}

const ACCOUNTS_BASE = (ZOHO_ACCOUNTS_BASE && ZOHO_ACCOUNTS_BASE.replace(/\/$/, '')) || 'https://accounts.zoho.com';
const SMTP_HOST = smtpHostFromAccountsBase(ACCOUNTS_BASE);

let transporter = null;
let currentAccess = { token: null, expiresAt: 0, apiDomain: null };

/** Exchange refresh token for access token */
async function fetchAccessToken() {
  try {
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
  } catch (err) {
    console.error('Failed to obtain Zoho access token:', err?.response?.data || err.message || err);
    throw err;
  }
}

/** Create transporter (STARTTLS on 587) with XOAUTH2 (preferred) */
async function ensureTransporter() {
  if (transporter && Date.now() < (currentAccess.expiresAt - 30 * 1000)) {
    return transporter;
  }

  const tokenData = await fetchAccessToken();
  const accessToken = tokenData.access_token;
  const expiresIn = tokenData.expires_in || 3600;
  const apiDomain = tokenData.api_domain || null;

  currentAccess.token = accessToken;
  currentAccess.expiresAt = Date.now() + (expiresIn * 1000);
  currentAccess.apiDomain = apiDomain;

  // create nodemailer transporter (STARTTLS)
  transporter = nodemailer.createTransport({
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
    await transporter.verify();
    console.log(`✅ SMTP transporter verified (host=${SMTP_HOST})`);
  } catch (err) {
    // Log full error object for diagnosis but don't crash
    console.error('Transporter verify failed:', err && err.message ? err.message : err);
    if (err?.response) console.error('Transporter verify response:', err.response);
  }

  return transporter;
}

/** Send via Zoho Mail REST API (fallback) */
async function sendViaZohoApi({ to, subject, text, html }) {
  try {
    if (!currentAccess.token || Date.now() > (currentAccess.expiresAt - 30 * 1000)) {
      const tokenData = await fetchAccessToken();
      currentAccess.token = tokenData.access_token;
      currentAccess.expiresAt = Date.now() + ((tokenData.expires_in || 3600) * 1000);
      currentAccess.apiDomain = tokenData.api_domain || currentAccess.apiDomain;
    }

    // determine API base (Zoho may return api_domain)
    const apiBase = currentAccess.apiDomain || 'https://www.zohoapis.com';
    const mailUrl = `${apiBase.replace(/\/$/, '')}/mail/v1/messages`;

    // payload - Zoho accepts a 'message' object or simple fields; we'll use the basic supported fields
    const payload = {
      fromAddress: ZOHO_EMAIL,
      toAddress: to,
      subject,
      content: text || (html ? html : '')
    };

    const resp = await axios.post(mailUrl, payload, {
      headers: {
        Authorization: `Zoho-oauthtoken ${currentAccess.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    console.log('Zoho API send response:', resp.data);
    return resp.data;
  } catch (err) {
    // Log detailed API error
    console.error('--- API ERROR ---');
    if (err?.response) {
      console.error('status:', err.response.status);
      console.error('data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message || err);
    }
    throw err;
  }
}

// Background token refresh
setInterval(async () => {
  try {
    if (!currentAccess.expiresAt || Date.now() > (currentAccess.expiresAt - 60 * 1000)) {
      console.log('Refreshing Zoho access token (background) ...');
      await ensureTransporter();
      console.log('Refreshed Zoho access token (background).');
    }
  } catch (err) {
    console.error('Background refresh error:', err?.message || err);
  }
}, 30 * 1000);

// Health check
app.get('/', (req, res) => res.status(200).send('Uwezo Link server is running.'));

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  console.log('POST /webhook received:', JSON.stringify(req.body));
  const { 'form-name': formName, ...fields } = req.body;

  const mailOptions = {
    from: `"Uwezo Link" <${ZOHO_EMAIL}>`,
    to: 'uwezolinkinitiative@gmail.com',
    subject: `New ${formName || 'form'} submission`,
    text: JSON.stringify(fields, null, 2)
  };

  try {
    const t = await ensureTransporter();

    // Try SMTP send first
    try {
      await t.sendMail(mailOptions);
      console.log(`📩 Email sent via SMTP for form: ${formName}`);
      return res.status(200).json({ message: 'Form submitted successfully (SMTP)' });
    } catch (smtpErr) {
      console.error('SMTP send failed:', smtpErr && smtpErr.message ? smtpErr.message : smtpErr);
      if (smtpErr?.response) console.error('SMTP response:', smtpErr.response);

      // Fallback to API
      try {
        await sendViaZohoApi({
          to: mailOptions.to,
          subject: mailOptions.subject,
          text: mailOptions.text
        });
        console.log(`📩 Email sent via Zoho Mail API for form: ${formName}`);
        return res.status(200).json({ message: 'Form submitted successfully (API fallback)' });
      } catch (apiErr) {
        console.error('API fallback failed (see API ERROR logs above).');
        return res.status(500).json({ error: 'Failed to send email' });
      }
    }
  } catch (err) {
    console.error('Error during sending flow:', err?.message || err);
    return res.status(500).json({ error: 'Failed to send email' });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
