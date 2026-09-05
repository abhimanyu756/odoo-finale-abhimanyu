import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transport = null;

const getTransport = () => {
  if (!env.mail.enabled) return null;
  transport = transport ?? nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.port === 465,
    auth: { user: env.mail.user, pass: env.mail.pass },
  });
  return transport;
};

// Without SMTP credentials the mailer logs instead of sending, so the payrun
// "Send Payslips" flow still works end-to-end in development.
export async function sendMail({ to, subject, text, html, attachments }) {
  const tx = getTransport();
  if (!tx) {
    console.log(`[mail:dry-run] to=${to} subject="${subject}" attachments=${attachments?.length ?? 0}`);
    return { delivered: false, dryRun: true };
  }
  const info = await tx.sendMail({ from: env.mail.from, to, subject, text, html, attachments });
  return { delivered: true, messageId: info.messageId };
}

export const mailEnabled = () => env.mail.enabled;
