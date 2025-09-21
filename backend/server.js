import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

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

// Pesapal Integration
const getBearerToken = async () => {
  const authData = new URLSearchParams({
    consumer_key: process.env.PESAPAL_CONSUMER_KEY,
    consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
  });

  const tokenUrl = `${process.env.PESAPAL_BASE_URL}api/Auth/RequestToken`;
  console.log('Requesting token from:', tokenUrl);

  try {
    const response = await axios.post(tokenUrl, authData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return response.data.token;
  } catch (error) {
    console.error('Pesapal Token Error:', error.response?.data || error.message);
    throw new Error('Authentication failed with Pesapal');
  }
};

const submitOrder = async (orderData) => {
  const token = await getBearerToken();
  const orderId = `DONATE-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const orderPayload = {
    id: orderId,
    currency: process.env.PESAPAL_CURRENCY || 'USD',
    amount: orderData.amount,
    description: orderData.description,
    callback_url: process.env.PESAPAL_CALLBACK_URL || 'https://www.uwezolinkinitiative.org/donate/success',
    notification_id: process.env.PESAPAL_IPN_ID || '',
    branch: 'Uwezo Link Initiative',
    billing_address: {
      email_address: orderData.donor.email,
      phone_number: orderData.donor.phone || '',
      country_code: orderData.donor.country || 'KE',
      first_name: orderData.donor.firstName,
      last_name: orderData.donor.lastName,
      line_1: '',
      city: 'Nairobi',
      state: 'Nairobi',
      zip: '00100',
    },
  };

  if (orderData.isRecurring) {
    orderPayload.save_token = true;
    orderPayload.token_description = `Monthly donation for ${orderData.donor.email}`;
  }

  const submitUrl = `${process.env.PESAPAL_BASE_URL}api/Transactions/SubmitOrderRequest`;
  console.log('Submitting order to:', submitUrl);

  try {
    const response = await axios.post(submitUrl, orderPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    return {
      redirectUrl: response.data.redirect_url,
      orderTrackingId: response.data.order_tracking_id,
      orderId,
    };
  } catch (error) {
    console.error('Pesapal Submit Error:', error.response?.data || error.message);
    throw new Error('Payment initiation failed');
  }
};

app.post('/api/donate', async (req, res) => {
  try {
    const orderData = req.body;
    if (!orderData.amount || orderData.amount < 1) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!orderData.donor?.email) {
      return res.status(400).json({ error: 'Donor email required' });
    }

    const result = await submitOrder(orderData);

    console.log('Donation initiated:', { orderId: result.orderId, email: orderData.donor.email, amount: orderData.amount });

    await transporter.sendMail({
      from: '"Uwezo Link" <info@uwezolinkinitiative.org>',
      to: orderData.donor.email,
      subject: `Thank You for Your Donation - Order ${result.orderId}`,
      text: `Thank you for your $${orderData.amount} donation! Order ID: ${result.orderId}. Impact: Your gift supports STEM education in Kenya. A tax receipt will be sent separately if applicable.`,
    });

    res.json(result);
  } catch (error) {
    console.error('Donation API Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/pesapal/ipn', async (req, res) => {
  const { order_tracking_id } = req.body;

  if (!order_tracking_id) {
    console.log('Invalid IPN: No order_tracking_id');
    return res.status(400).send('Invalid IPN');
  }

  try {
    const token = await getBearerToken();
    const statusUrl = `${process.env.PESAPAL_BASE_URL}api/Transactions/GetTransactionStatus?orderTrackingId=${order_tracking_id}`;
    console.log('Getting status from:', statusUrl);

    const statusResponse = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${token}` } });

    const status = statusResponse.data;
    console.log('IPN Received:', { order_tracking_id, status: status.payment_status });

    if (status.payment_status === 'COMPLETED') {
      await transporter.sendMail({
        from: '"Uwezo Link" <info@uwezolinkinitiative.org>',
        to: status.billing_address?.email_address || 'info@uwezolinkinitiative.org',
        subject: `Donation Confirmation - Order ${order_tracking_id}`,
        text: `Thank you for your $${status.amount} donation! Order ID: ${order_tracking_id}. Impact: Your gift supports STEM education in Kenya.`,
      });

      if (status.token?.token_id) {
        console.log('Recurring token saved:', status.token.token_id);
      }
    } else if (status.payment_status === 'FAILED') {
      console.log('Payment failed:', order_tracking_id);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('IPN Processing Error:', error);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));