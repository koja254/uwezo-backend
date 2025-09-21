// server.js
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// --- Runtime env validation for essential vars ---
const requiredEnv = ['ZOHO_PASSWORD'];
const missingRequired = requiredEnv.filter(k => !process.env[k]);
if (missingRequired.length) {
  console.error(`Missing required env vars: ${missingRequired.join(', ')}`);
  process.exit(1);
}

// Check Pesapal optional-but-important envs; if missing we'll disable donate endpoints gracefully
const pesapalEnvVars = ['PESAPAL_BASE_URL', 'PESAPAL_CONSUMER_KEY', 'PESAPAL_CONSUMER_SECRET'];
const missingPesapal = pesapalEnvVars.filter(k => !process.env[k]);
const pesapalEnabled = missingPesapal.length === 0;

if (!pesapalEnabled) {
  console.warn(`Pesapal disabled: missing env vars: ${missingPesapal.join(', ')}. /api/donate and /pesapal/ipn will return 503.`);
}

const app = express();

// Enable CORS for specific origins
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:8080',
    'https://68cff80dfb39110008410e75--gorgeous-seahorse-93fdcc.netlify.app',
    'https://uwezolinkinitiative.org'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false
}));

app.use(express.json({ limit: '100kb' }));

// Log all requests for debugging (kept minimal)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} Origin: ${req.headers.origin || '-'}`);
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

// Basic health route and webhook route
app.get('/', (req, res) => res.status(200).send('Uwezo Link server is running.'));
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
        subject: `New ${formName || 'form'} submission`,
        text: JSON.stringify(fields, null, 2),
      });
      console.log(`Email sent for form: ${formName}`);
      return res.status(200).json({ message: 'Form submitted successfully' });
    } catch (error) {
      attempts++;
      console.error(`Attempt ${attempts} failed for form ${formName}:`, {
        message: error?.message,
        code: error?.code,
        response: error?.response?.toString?.() || error?.response,
      });
      if (attempts === maxRetries) {
        return res.status(500).json({ error: `Error processing form: ${error?.message || 'unknown'}` });
      }
    }
  }
});

// ---------- Pesapal Integration Helpers ----------
/**
 * Robust function to request bearer token.
 * Tries JSON first, then urlencoded form as a fallback. Parses common token fields.
 */
const getBearerToken = async () => {
  if (!pesapalEnabled) {
    throw new Error('Pesapal integration disabled: missing environment variables');
  }

  const tokenUrl = `${process.env.PESAPAL_BASE_URL.replace(/\/+$/, '')}/api/Auth/RequestToken`;
  console.log('Requesting token from:', tokenUrl);

  const payloadJson = {
    consumer_key: process.env.PESAPAL_CONSUMER_KEY,
    consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
  };

  const axiosConfigBase = {
    timeout: 8000,
    validateStatus: status => status >= 200 && status < 500, // we'll handle non-2xx explicitly
  };

  const attempts = [
    {
      // Try JSON body first (some endpoints accept JSON)
      headers: { 'Content-Type': 'application/json' },
      body: payloadJson,
      desc: 'json'
    },
    {
      // Fallback to form-urlencoded
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payloadJson).toString(),
      desc: 'form-urlencoded'
    }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const response = await axios.post(tokenUrl, attempt.body, { ...axiosConfigBase, headers: attempt.headers });
      if (response.status >= 200 && response.status < 300) {
        const data = response.data || {};
        // Common token fields
        const token = data.token || data.access_token || data.accessToken || data.Token || data.result?.token;
        if (token) {
          console.log(`Obtained Pesapal token (via ${attempt.desc}).`);
          return token;
        } else {
          // if response is 200 but token not present, surface the full response for debugging
          const sample = typeof data === 'object' ? JSON.stringify(data) : String(data);
          throw new Error(`Token not found in response. Body: ${sample}`);
        }
      } else {
        // Non-2xx returned - capture body for debug
        const status = response.status;
        const body = response.data;
        throw new Error(`Non-2xx status ${status}. Body: ${JSON.stringify(body)}`);
      }
    } catch (err) {
      lastError = err;
      console.warn(`Pesapal token attempt (${attempt.desc}) failed:`, err.message || err);
      // try next attempt
    }
  }

  // If we get here, all attempts failed
  console.error('Pesapal Token Error after attempts:', lastError && (lastError.stack || lastError.message || lastError));
  // Provide the caller a helpful error string
  const readable = lastError?.message || 'unknown error while requesting Pesapal token';
  throw new Error(`Authentication failed with Pesapal: ${readable}`);
};

const submitOrder = async (orderData) => {
  if (!pesapalEnabled) throw new Error('Pesapal disabled: cannot submit order');

  // request token
  const token = await getBearerToken();

  const orderId = `DONATE-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const amount = Number(orderData.amount);

  const orderPayload = {
    id: orderId,
    currency: process.env.PESAPAL_CURRENCY || 'USD',
    amount,
    description: orderData.description || 'Donation',
    callback_url: process.env.PESAPAL_CALLBACK_URL || 'https://www.uwezolinkinitiative.org/donate/success',
    notification_id: process.env.PESAPAL_IPN_ID || '',
    branch: 'Uwezo Link Initiative',
    billing_address: {
      email_address: orderData.donor?.email,
      phone_number: orderData.donor?.phone || '',
      country_code: orderData.donor?.country || 'KE',
      first_name: orderData.donor?.firstName || '',
      last_name: orderData.donor?.lastName || '',
      line_1: '',
      city: orderData.donor?.city || 'Nairobi',
      state: orderData.donor?.state || 'Nairobi',
      zip: orderData.donor?.zip || '00100',
    },
  };

  if (orderData.isRecurring) {
    orderPayload.save_token = true;
    orderPayload.token_description = `Monthly donation for ${orderData.donor?.email || 'donor'}`;
  }

  const submitUrl = `${process.env.PESAPAL_BASE_URL.replace(/\/+$/, '')}/api/Transactions/SubmitOrderRequest`;
  console.log('Submitting order to:', submitUrl);

  try {
    const response = await axios.post(submitUrl, orderPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 10000,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Pesapal returned status ${response.status} - ${JSON.stringify(response.data)}`);
    }

    // Expecting redirect_url and order_tracking_id in response.data
    const data = response.data || {};
    return {
      redirectUrl: data.redirect_url || data.redirectUrl || data.redirect || null,
      orderTrackingId: data.order_tracking_id || data.orderTrackingId || null,
      orderId,
      rawResponse: data,
    };
  } catch (err) {
    console.error('Pesapal Submit Error:', err.response?.data || err.message || err);
    throw new Error('Payment initiation failed: ' + (err.message || 'unknown'));
  }
};

// ---------- API endpoints ----------
app.post('/api/donate', async (req, res) => {
  if (!pesapalEnabled) {
    return res.status(503).json({ error: 'Payment system not configured. Contact admin.' });
  }

  try {
    const orderData = req.body || {};
    if (!orderData.amount || Number(orderData.amount) < 1) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!orderData.donor?.email) {
      return res.status(400).json({ error: 'Donor email required' });
    }

    const result = await submitOrder(orderData);

    console.log('Donation initiated:', { orderId: result.orderId, email: orderData.donor.email, amount: orderData.amount });

    // Send a thank-you email to donor (best-effort)
    try {
      await transporter.sendMail({
        from: '"Uwezo Link" <info@uwezolinkinitiative.org>',
        to: orderData.donor.email,
        subject: `Thank You for Your Donation - Order ${result.orderId}`,
        text: `Thank you for your ${result.rawResponse?.currency || ''} ${orderData.amount} donation! Order ID: ${result.orderId}. Impact: Your gift supports STEM education in Kenya. A tax receipt will be sent separately if applicable.`,
      });
    } catch (emailErr) {
      console.warn('Failed to send donor email:', emailErr && (emailErr.message || emailErr));
      // Not fatal for the donation flow
    }

    return res.json(result);
  } catch (error) {
    console.error('Donation API Error:', error && (error.stack || error.message || error));
    return res.status(500).json({ error: error.message || 'Unknown server error' });
  }
});

app.post('/pesapal/ipn', async (req, res) => {
  if (!pesapalEnabled) {
    return res.status(503).send('Pesapal integration not configured');
  }

  const { order_tracking_id } = req.body || {};

  if (!order_tracking_id) {
    console.log('Invalid IPN: No order_tracking_id');
    return res.status(400).send('Invalid IPN');
  }

  try {
    const token = await getBearerToken();
    const statusUrl = `${process.env.PESAPAL_BASE_URL.replace(/\/+$/, '')}/api/Transactions/GetTransactionStatus?orderTrackingId=${order_tracking_id}`;
    console.log('Getting status from:', statusUrl);

    const statusResponse = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });
    const status = statusResponse.data || {};

    console.log('IPN Received:', { order_tracking_id, status: status.payment_status || status.paymentStatus || status.status });

    const paymentStatus = status.payment_status || status.paymentStatus || status.status;

    if (paymentStatus === 'COMPLETED' || paymentStatus === 'Success' || paymentStatus === 'SUCCESS') {
      try {
        await transporter.sendMail({
          from: '"Uwezo Link" <info@uwezolinkinitiative.org>',
          to: status.billing_address?.email_address || 'info@uwezolinkinitiative.org',
          subject: `Donation Confirmation - Order ${order_tracking_id}`,
          text: `Thank you for your ${status.amount || ''} donation! Order ID: ${order_tracking_id}. Impact: Your gift supports STEM education in Kenya.`,
        });
      } catch (mailErr) {
        console.warn('Failed to send confirmation email:', mailErr && (mailErr.message || mailErr));
      }

      if (status.token?.token_id) {
        console.log('Recurring token saved:', status.token.token_id);
      }
    } else if (paymentStatus === 'FAILED' || paymentStatus === 'Failed') {
      console.log('Payment failed:', order_tracking_id, 'status:', paymentStatus);
    } else {
      console.log('Payment status (unhandled):', paymentStatus);
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('IPN Processing Error:', error && (error.stack || error.message || error));
    return res.status(500).send('Error');
  }
});

// Fallback 404 handler for unknown routes (keeps Render's message clearer)
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
