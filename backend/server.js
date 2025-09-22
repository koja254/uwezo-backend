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
  ZOHO_ACCOUNTS_BASE // e.g. https://accounts.zoho.com  (optional)
} = process.env;

if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN || !ZOHO_EMAIL) {
  console.error('❌ Missing required env vars. Please set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and ZOHO_EMAIL in your .env');
  process.exit(1);
}

const app = express();

// Enable CORS for your allowed origins
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

// Minimal request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --- Zoho OAuth2 / Nodemailer setup ---
// ACCOUNTS_BASE: region endpoint; default to https://accounts.zoho.com
const ACCOUNTS_BASE = ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.com';

let transporter = null;
let currentAccess = { token: null, expiresAt: 0, apiDomain: null };

/**
 * Exchange refresh token for access token.
 * Returns token object { access_token, expires_in, api_domain, ... }
 */
async function fetchAccessToken() {
  try {
    const url = `${ACCOUNTS_BASE.replace(/\/$/, '')}/oauth/v2/token`;
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

    return resp.data;
  } catch (err) {
    console.error('Failed to obtain Zoho access token:', err?.response?.data || err.message || err);
    throw err;
  }
}

/**
 * Create or refresh the Nodemailer transporter using XOAUTH2 on STARTTLS (port 587).
 * Many Zoho accounts accept XOAUTH2 on port 587 with STARTTLS.
 */
async function ensureTransporter() {
  // If transporter exists and token still valid, reuse it
  if (transporter && Date.now() < (currentAccess.expiresAt - 30 * 1000)) {
    return transporter;
  }

  // Obtain fresh access token (and api_domain)
  const tokenData = await fetchAccessToken();
  const accessToken = tokenData.access_token;
  const expiresIn = tokenData.expires_in || 3600;
  const apiDomain = tokenData.api_domain || null;

  currentAccess.token = accessToken;
  currentAccess.expiresAt = Date.now() + (expiresIn * 1000);
  currentAccess.apiDomain = apiDomain;

  // Create transporter using STARTTLS (port 587) and explicit XOAUTH2
  transporter = nodemailer.createTransport({
    host: 'smtp.zoho.com',       // try smtp.zoho.eu / smtp.zoho.in if your org is regional
    port: 587,
    secure: false,               // use STARTTLS
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

  // Verify transporter (non-blocking, helpful to surface errors early)
  try {
    await transporter.verify();
    console.log('✅ Zoho transporter verified (XOAUTH2 via STARTTLS).');
  } catch (err) {
    console.error('Transporter verify failed:', err);
    // Keep transporter (we still attempt to send; fallback to API if send fails)
  }

  return transporter;
}

/**
 * Send mail using Zoho Mail REST API (fallback if SMTP XOAUTH2 fails).
 * Uses current access token; will call fetchAccessToken() if necessary.
 */
async function sendViaZohoApi({ to, subject, text, html }) {
  try {
    // Ensure we have a valid access token
    if (!currentAccess.token || Date.now() > (currentAccess.expiresAt - 30 * 1000)) {
      const tokenData = await fetchAccessToken();
      currentAccess.token = tokenData.access_token;
      currentAccess.expiresAt = Date.now() + ((tokenData.expires_in || 3600) * 1000);
      currentAccess.apiDomain = tokenData.api_domain || currentAccess.apiDomain;
    }

    // Determine API base domain (Zoho sometimes returns api_domain like https://www.zohoapis.com)
    const apiBase = currentAccess.apiDomain || 'https://www.zohoapis.com';
    // Mail send endpoint
    const mailUrl = `${apiBase.replace(/\/$/, '')}/mail/v1/messages`;

    // Zoho Mail API expects payload fields; using simple content object
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

    return resp.data;
  } catch (err) {
    // Bubble up meaningful error
    console.error('Zoho Mail API send failed:', err?.response?.data || err.message || err);
    throw err;
  }
}

// Background refresh: keep token fresh (refresh early)
setInterval(async () => {
  try {
    if (!currentAccess.expiresAt || Date.now() > (currentAccess.expiresAt - 60 * 1000)) {
      console.log('Refreshing Zoho access token (background)...');
      await ensureTransporter();
      console.log('Refreshed Zoho access token (background).');
    }
  } catch (err) {
    console.error('Error while refreshing Zoho access token:', err?.message || err);
  }
}, 30 * 1000); // check every 30s

// Health check
app.get('/', (req, res) => res.status(200).send('Uwezo Link server is running.'));

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  console.log('POST /webhook received:', req.body);

  const { 'form-name': formName, ...fields } = req.body;

  const mailOptions = {
    from: `"Uwezo Link" <${ZOHO_EMAIL}>`,
    to: 'uwezolinkinitiative@gmail.com',
    subject: `New ${formName || 'form'} submission`,
    text: JSON.stringify(fields, null, 2)
  };

  try {
    // Ensure transporter exists (this will refresh tokens as needed)
    const t = await ensureTransporter();

    // Try SMTP send first
    try {
      await t.sendMail(mailOptions);
      console.log(`📩 Email sent via SMTP for form: ${formName}`);
      return res.status(200).json({ message: 'Form submitted successfully (SMTP)' });
    } catch (smtpErr) {
      console.error('SMTP send failed:', smtpErr?.response || smtpErr?.message || smtpErr);

      // If SMTP failed due to auth/XOAUTH2 issues, fallback to Zoho Mail API
      // We'll attempt API fallback for any SMTP failure to be resilient.
      try {
        await sendViaZohoApi({
          to: mailOptions.to,
          subject: mailOptions.subject,
          text: mailOptions.text
        });
        console.log(`📩 Email sent via Zoho Mail API for form: ${formName}`);
        return res.status(200).json({ message: 'Form submitted successfully (API fallback)' });
      } catch (apiErr) {
        console.error('API fallback also failed:', apiErr?.response || apiErr?.message || apiErr);
        return res.status(500).json({ error: 'Failed to send email via SMTP and API fallback' });
      }
    }
  } catch (error) {
    console.error('❌ Error sending email (setup):', (error && error.message) || error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Fallback 404
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
