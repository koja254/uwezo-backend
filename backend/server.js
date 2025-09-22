require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => res.send('Uwezo backend running 🚀'));

// General webhook endpoint for all forms
app.post('/webhook', async (req, res) => {
  try {
    const { 'form-name': formName, ...fields } = req.body;

    // You can customize recipients per form
    const to = "uwezolinkinitiative@gmail.com";
    const subject = `New ${formName || 'form'} submission`;
    const content = JSON.stringify(fields, null, 2); // or convert to HTML if you want

    const response = await axios.post(
      `https://mail.zoho.com/api/accounts/${process.env.ZOHO_ACCOUNT_ID}/messages`,
      {
        fromAddress: "info@uwezolinkinitiative.org",
        toAddress: to,
        subject,
        content
      },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.status(200).json({ message: 'Form submitted successfully', zohoResponse: response.data });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
