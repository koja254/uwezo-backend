// server.js
import 'dotenv/config'; // loads .env automatically
import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 10000;

// --- Middleware ---
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

// --- Utility function: send email via Zoho REST API ---
async function sendEmail({ to, subject, content }) {
  if (!process.env.ZOHO_ACCESS_TOKEN || !process.env.ZOHO_ACCOUNT_ID) {
    throw new Error('Missing ZOHO_ACCESS_TOKEN or ZOHO_ACCOUNT_ID in env');
  }

  const apiUrl = `https://mail.zoho.com/api/accounts/${process.env.ZOHO_ACCOUNT_ID}/messages`;

  const payload = {
    fromAddress: process.env.ZOHO_EMAIL,
    toAddress: to,
    subject,
    content,
  };

  const response = await axios.post(apiUrl, payload, {
    headers: {
      Authorization: `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  return response.data;
}

// --- Health check ---
app.get('/', (req, res) => res.send('Uwezo backend running 🚀'));

// --- Webhook endpoint for all forms ---
app.post('/webhook', async (req, res) => {
  try {
    const { 'form-name': formName, ...fields } = req.body;
    const to = 'uwezolinkinitiative@gmail.com';
    const subject = `New ${formName || 'form'} submission`;
    const content = JSON.stringify(fields, null, 2);

    const result = await sendEmail({ to, subject, content });
    console.log(`[${new Date().toISOString()}] Form "${formName}" sent successfully.`);

    res.status(200).json({ message: 'Form submitted successfully', zohoResponse: result });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to send form:`, err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// --- 404 handler ---
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

// --- Start server ---
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
