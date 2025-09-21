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

// Pesapal envs (optional — app runs without them, but payments disabled)
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
    'https://689f57bc91ed6f00081b1a97--gorgeous-seahorse-93fdcc.netlify.app',
    'https://uwezolinkinitiative.org'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false
}));

app.use(express.json({ limit: '100kb' }));

// Minimal request logging
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

transporter.verify((error) => {
  if (error) {
    console.error('SMTP connection error:', error);
  } else {
    console.log('SMTP server is ready to take messages');
  }
});

// Health & webhook endpoints
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
        response: error?.response?.data || error?.response?.toString?.() || error?.response,
      });
      if (attempts === maxRetries) {
        return res.status(500).json({ error: `Error processing form: ${error?.message || 'unknown'}` });
      }
    }
  }
});

// ----------------------
// Pesapal helpers
// ----------------------

// Normalize user-provided PESAPAL_BASE_URL into an object with well-known endpoints.
// Accepts common variants:
// - Sandbox/demo: https://cybqa.pesapal.com/pesapalv3
// - Production:    https://pay.pesapal.com/v3
// - Sometimes users may set trailing slashes or different subpaths.
function normalizePesapalBase(rawBase) {
  if (!rawBase) return null;
  let base = String(rawBase).trim();
  // remove trailing slash(es)
  base = base.replace(/\/+$/, '');

  // Common sandbox pattern contains 'pesapalv3'
  if (base.includes('pesapalv3')) {
    // keep as-is: example: https://cybqa.pesapal.com/pesapalv3
    return {
      tokenBase: `${base}/api/Auth/RequestToken`,
      submitOrderBase: `${base}/api/Transactions/SubmitOrderRequest`,
      statusBase: `${base}/api/Transactions/GetTransactionStatus`
    };
  }

  // Common production pattern is pay.pesapal.com/v3
  if (base.includes('pay.pesapal.com') && base.includes('/v3')) {
    // example: https://pay.pesapal.com/v3
    const trimmed = base.replace(/\/+$/, '');
    return {
      tokenBase: `${trimmed}/api/Auth/RequestToken`,
      submitOrderBase: `${trimmed}/api/Transactions/SubmitOrderRequest`,
      statusBase: `${trimmed}/api/Transactions/GetTransactionStatus`
    };
  }

  // If user supplied the older mistaken variant like pay.pesapal.com/pesapalv3, map it to the correct production v3
  if (base.includes('pay.pesapal.com') && base.includes('pesapalv3')) {
    const mapped = base.replace('pesapalv3', 'v3');
    return {
      tokenBase: `${mapped}/api/Auth/RequestToken`,
      submitOrderBase: `${mapped}/api/Transactions/SubmitOrderRequest`,
      statusBase: `${mapped}/api/Transactions/GetTransactionStatus`
    };
  }

  // If user supplied a URL that already contains /api/Auth/RequestToken, use as provided
  if (base.toLowerCase().includes('/api/auth/requesttoken')) {
    const root = base.replace(/\/api\/auth\/requesttoken.*$/i, '');
    return {
      tokenBase: `${root}/api/Auth/RequestToken`,
      submitOrderBase: `${root}/api/Transactions/SubmitOrderRequest`,
      statusBase: `${root}/api/Transactions/GetTransactionStatus`
    };
  }

  // Last resort: append v3 then endpoints
  const fallback = base + (base.endsWith('/v3') ? '' : '/v3');
  return {
    tokenBase: `${fallback}/api/Auth/RequestToken`,
    submitOrderBase: `${fallback}/api/Transactions/SubmitOrderRequest`,
    statusBase: `${fallback}/api/Transactions/GetTransactionStatus`
  };
}

const pesapalConfig = pesapalEnabled ? normalizePesapalBase(process.env.PESAPAL_BASE_URL) : null;

// Robust function to get bearer token. Accepts both JSON and form payloads depending on server.
const getBearerToken = async () => {
  if (!pesapalEnabled || !pesapalConfig) {
    throw new Error('Pesapal integration disabled or not configured correctly');
  }

  const tokenUrl = pesapalConfig.tokenBase;
  console.log('Requesting token from:', tokenUrl);

  const payload = {
    consumer_key: process.env.PESAPAL_CONSUMER_KEY,
    consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
  };

  const axiosBase = {
    timeout: 8000,
    validateStatus: s => s >= 200 && s < 500 // handle non-2xx ourselves
  };

  const strategies = [
    { desc: 'json', body: payload, headers: { 'Content-Type': 'application/json' } },
    { desc: 'form', body: new URLSearchParams(payload).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  ];

  let lastError = null;
  for (const strat of strategies) {
    try {
      const resp = await axios.post(tokenUrl, strat.body, { ...axiosBase, headers: strat.headers });
      if (resp.status >= 200 && resp.status < 300) {
        const data = resp.data || {};
        const token = data.token || data.access_token || data.accessToken || data.Token || data.result?.token;
        if (token) {
          console.log(`Obtained Pesapal token (via ${strat.desc})`);
          return token;
        } else {
          throw new Error(`No token field in response body: ${JSON.stringify(data)}`);
        }
      } else {
        throw new Error(`Non-2xx status ${resp.status}. Body: ${typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)}`);
      }
    } catch (err) {
      lastError = err;
      console.warn(`Pesapal token attempt (${strat.desc}) failed:`, err.message || err);
      // try next strategy
    }
  }

  console.error('Pesapal Token Error after attempts:', lastError && (lastError.stack || lastError.message || lastError));
  throw new Error(`Authentication failed with Pesapal: ${lastError?.message || 'unknown'}`);
};

const submitOrder = async (orderData) => {
  if (!pesapalEnabled || !pesapalConfig) throw new Error('Pesapal disabled: cannot submit order');

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

  const submitUrl = pesapalConfig.submitOrderBase;
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

// ----------------------
// API endpoints
// ----------------------

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

    // Best-effort thank-you email
    try {
      await transporter.sendMail({
        from: '"Uwezo Link" <info@uwezolinkinitiative.org>',
        to: orderData.donor.email,
        subject: `Thank You for Your Donation - Order ${result.orderId}`,
        text: `Thank you for your ${result.rawResponse?.currency || ''} ${orderData.amount} donation! Order ID: ${result.orderId}. Impact: Your gift supports STEM education in Kenya.`,
      });
    } catch (emailErr) {
      console.warn('Failed to send donor email:', emailErr && (emailErr.message || emailErr));
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
    const statusUrl = `${pesapalConfig.statusBase}?orderTrackingId=${order_tracking_id}`;
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

// Fallback 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
