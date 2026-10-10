/**
 * The one place the app loads Nodemailer.
 *
 * Nodemailer caches ONE Ethereal test account per process unless ETHEREAL_CACHE is off, so a
 * second createTestAccount() would return the same mailbox again (and every user would need
 * a new process per sender). It reads the variable once, when the module is first loaded, so
 * it is switched off here, before the require.
 */
process.env.ETHEREAL_CACHE = 'no';

// The default export, i.e. the same object `import nodemailer from 'nodemailer'` gives.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const nodemailer: typeof import('nodemailer').default = require('nodemailer').default;
export type { Transporter } from 'nodemailer';
