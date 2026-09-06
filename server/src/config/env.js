import 'dotenv/config';

const required = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

export const env = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessTtl: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshTtl: process.env.REFRESH_TOKEN_TTL || '7d',
  },
  // Optional. Without a key the assistant degrades to a clear message rather
  // than failing, so the app runs exactly as before.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || null,
    // "…-latest" tracks Google's current flash model, so a retired version
    // never silently breaks the assistant the way gemini-2.0-flash did.
    model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    // Tried when the primary is rate limited or overloaded.
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash',
    enabled: Boolean(process.env.GEMINI_API_KEY),
  },
  mail: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || 'PeoplePay360 <no-reply@peoplepay360.local>',
    // Without credentials the mailer falls back to logging instead of sending.
    enabled: Boolean(process.env.SMTP_USER && process.env.SMTP_PASS),
  },
};
