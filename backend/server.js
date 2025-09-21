// server.js
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

// --- Required env vars ---
if (!process.env.ZOHO_PASSWORD) {
  console.error('❌ Missing required env var: ZOHO_PASSWORD');
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

// Nodemailer transporter (Zoho)
const transporter = nodemailer.createTransport({
  host: 'smtppro.zoho.com',
  port: 587,
  secure: false,
  auth: {
    user: 'info@uwezolinkinitiative.org',
    pass: process.env.ZOHO_PASSWORD,
  },
  tls: {
    ciphers: 'SSLv3',
  },
});

transporter.verify((error) => {
  if (error) {
    console.error('SMTP connection error:', error);
  } else {
    console.log('✅ SMTP server is ready to take messages');
  }
});

// Health check
app.get('/', (req, res) => res.status(200).send('Uwezo Link server is running.'));

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  console.log('POST /webhook received:', req.body);

  const { 'form-name': formName, ...fields } = req.body;

  try {
    await transporter.sendMail({
      from: '"Uwezo Link" <info@uwezolinkinitiative.org>',
      to: 'uwezolinkinitiative@gmail.com',
      subject: `New ${formName || 'form'} submission`,
      text: JSON.stringify(fields, null, 2),
    });

    console.log(`📩 Email sent for form: ${formName}`);
    res.status(200).json({ message: 'Form submitted successfully' });
  } catch (error) {
    console.error('❌ Error sending email:', error.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Fallback 404
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
