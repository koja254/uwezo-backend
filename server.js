// backend/server.js
import express from 'express';
import nodemailer from 'nodemailer';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
app.use(bodyParser.json());

// Zoho SMTP setup
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: "tevinxrider@gmail.com", // your Zoho email
    pass: process.env.ZOHO_PASSWORD // store password in .env
  }
});

// Webhook route for Netlify
app.post('/webhook', async (req, res) => {
  const { form_name, ...fields } = req.body;

  try {
    await transporter.sendMail({
      from: '"Uwezo Link" <info@empowerit.org>',
      to: "info@empowerit.org",
      subject: `New ${form_name} submission`,
      text: JSON.stringify(fields, null, 2)
    });
    res.status(200).send('Email sent');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error sending email');
  }
});

app.listen(3000, () => console.log('✅ Server running on port 3000'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
