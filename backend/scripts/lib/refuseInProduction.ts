/**
 * Imported FIRST by scripts that must never run against production (seed:demo): it stops
 * before any app module is loaded, i.e. before anything connects to the database or Redis.
 * NODE_ENV is read from the shell or backend/.env, the same way the app reads it.
 */
import { config } from 'dotenv';

config(); // doesn't override variables already set in the shell

if (process.env.NODE_ENV === 'production') {
  console.error(
    'Refusing to run: NODE_ENV=production.\n'
    + 'seed:demo creates the demo account (oliver.brown@domain.io) with a publicly known password.\n'
    + 'It is for local development only and must never exist in production.',
  );
  process.exit(1);
}
