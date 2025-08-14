import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const transporter = nodemailer.createTransport({
  host: 'smtppro.zoho.com',
  port: 465,
  secure: true,
  auth: {
    user: 'info@uwezolinkinitiative.org',
    pass: process.env.ZOHO_PASSWORD,
  },
});

async function testEmail() {
  try {
    const info = await transporter.sendMail({
      from: '"Uwezo Link" <info@uwezolinkinitiative.org>',
      to: 'tevinxrider@gmail.com',
      subject: 'Test Email from Uwezo Link',
      text: 'This is a test email to verify SMTP configuration.',
    });
    console.log('Email sent:', info.messageId);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

testEmail();