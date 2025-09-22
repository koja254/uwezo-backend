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
  ZOHO_ACCOUNTS_BASE
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
// We'll exchange the refresh token for an access token and create a transporter that uses OAuth2.
// ACCOUNTS_BASE: region endpoint; default to accounts.zoho.com
const ACCOUNTS_BASE = ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.com';

let transporter = null;
let currentAccess = { token: null, expiresAt: 0 };

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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    // resp.data contains access_token and expires_in among others
    return resp.data;
  } catch (err) {
    console.error('Failed to obtain Zoho access token:', err?.response?.data || err.message || err);
    throw err;
  }
}

async function ensureTransporter() {
  // If already created and token not near expiry, reuse
  if (transporter && Date.now() < (currentAccess.expiresAt - 30 * 1000)) {
    return transporter;
  }

  // Obtain access token
  const tokenData = await fetchAccessToken();
  const accessToken = tokenData.access_token;
  const expiresIn = tokenData.expires_in || 3600; // seconds

  currentAccess.token = accessToken;
  currentAccess.expiresAt = Date.now() + (expiresIn * 1000);

  // Create a nodemailer transporter that authenticates with OAuth2
  transporter = nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true, // TLS
    auth: {
      type: 'OAuth2',
      user: ZOHO_EMAIL,
      clientId: ZOHO_CLIENT_ID,
      clientSecret: ZOHO_CLIENT_SECRET,
      refreshToken: ZOHO_REFRESH_TOKEN,
      accessToken: accessToken
    },
    tls: {
      ciphers: 'SSLv3',
    },
  });

  // Verify transporter (non-blocking but helpful)
  try {
    await transporter.verify();
    console.log('✅ Zoho transporter verified (OAuth2).');
  } catch (err) {
    console.error('Transporter verify failed:', err);
  }

  return transporter;
}

// Background refresh: check and refresh access token before expiry
setInterval(async () => {
  try {
    if (!currentAccess.expiresAt || Date.now() > (currentAccess.expiresAt - 60 * 1000)) {
      console.log('Refreshing Zoho access token...');
      await ensureTransporter();
      console.log('Refreshed Zoho access token.');
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

  try {
    const t = await ensureTransporter();

    await t.sendMail({
      from: `"Uwezo Link" <${ZOHO_EMAIL}>`,
      to: 'uwezolinkinitiative@gmail.com',
      subject: `New ${formName || 'form'} submission`,
      text: JSON.stringify(fields, null, 2),
    });

    console.log(`📩 Email sent for form: ${formName}`);
    res.status(200).json({ message: 'Form submitted successfully' });
  } catch (error) {
    console.error('❌ Error sending email:', (error && error.message) || error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Fallback 404
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
