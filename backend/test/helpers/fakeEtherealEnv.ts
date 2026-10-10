/**
 * Imported FIRST by etherealProvisioning.test.ts: Nodemailer's Ethereal API address points at
 * a local fake (Nodemailer reads it once, when it is loaded).
 */
export const FAKE_ETHEREAL_PORT = 47_811;
process.env.ETHEREAL_API = `http://127.0.0.1:${FAKE_ETHEREAL_PORT}`;
