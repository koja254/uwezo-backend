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

// Enable CORS for specific origins
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:8080',
    'https://689f57bc91ed6f00081b1a97--gorgeous-seahorse-93fdcc.netlify.app',
    'https://uwezolinkinitiative.org' 
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false // Set to true if you need cookies or auth headers
}));

app.use(express.json());

// Log all requests for debugging
app.use((req, res, next) => {
  console.log('Request:', req.method, req.url, 'Origin:', req.headers.origin);
  next();
});

const transporter = nodemailer.createTransport({
  host: 'smtppro.zoho.com',
  port: 587,
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
        to: 'uwezolinkinitiative@gmail.com',
        subject: `New ${formName} submission`,
        text: JSON.stringify(fields, null, 2),
      });
      console.log(`Email sent for form: ${formName}`);
      return res.status(200).json({ message: 'Form submitted successfully' });
    } catch (error) {
      attempts++;
      console.error(`Attempt ${attempts} failed for form ${formName}:`, {
        message: error.message,
        code: error.code,
        response: error.response,
        responseCode: error.responseCode
      });
      if (attempts === maxRetries) {
        return res.status(500).json({ error: `Error processing form: ${error.message}` });
      }
    }
  }
});

const PORT = process.env.PORT || 10000; // Match your logs (port 10000)
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));