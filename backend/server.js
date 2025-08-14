import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.ZOHO_PASSWORD) {
  console.error('Error: ZOHO_PASSWORD is not set in environment variables');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    'https://689ca3f54cc438000805af21--gorgeous-seahorse-93fdcc.netlify.app', // No trailing slash
    'http://localhost:5173',
    'http://localhost:8080'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  preflightContinue: true
}));

// Log all requests for debugging
app.use((req, res, next) => {
  console.log('Request:', req.method, req.url, 'Origin:', req.headers.origin);
  next();
});

// Handle CORS preflight requests explicitly
app.options('/webhook', (req, res) => {
  console.log('Received OPTIONS preflight request for /webhook');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).send();
});

const transporter = nodemailer.createTransport({
  host: 'smtppro.zoho.com',
  port: 587, // Changed to 587 for Render compatibility
  secure: false,
  auth: {
    user: 'info@uwezolinkinitiative.org',
    pass: process.env.ZOHO_PASSWORD,
  },
  tls: {
    ciphers: 'SSLv3'
  }
});

transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP connection error:', error);
  } else {
    console.log('SMTP server is ready to take messages');
  }
});

app.get('/webhook', (req, res) => {
  console.log('GET /webhook accessed');
  res.status(200).send('Webhook endpoint is live. Use POST to submit form data.');
});

app.post('/webhook', async (req, res) => {
  console.log('POST /webhook received with headers:', req.headers);
  const { 'form-name': formName, ...fields } = req.body;
  console.log('Received form submission:', { formName, fields });

  const maxRetries = 2;
  let attempts = 0;

  while (attempts < maxRetries) {
    try {
      await transporter.sendMail({
        from: '"Uwezo Link" <info@uwezolinkinitiative.org>',
        to: 'tevinxrider@gmail.com',
        subject: `New ${formName} submission`,
        text: JSON.stringify(fields, null, 2),
      });
      console.log(`Email sent for form: ${formName}`);
      return res.status(200).send('Form submitted successfully');
    } catch (error) {
      attempts++;
      console.error(`Attempt ${attempts} failed for form ${formName}:`, {
        message: error.message,
        code: error.code,
        response: error.response,
        responseCode: error.responseCode
      });
      if (attempts === maxRetries) {
        return res.status(500).send(`Error processing form: ${error.message}`);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));