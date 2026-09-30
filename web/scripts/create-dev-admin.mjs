// Creates a new account only in the isolated local ai_cs_dev database.
import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/ai_cs_dev') {
  throw new Error('Only a local ai_cs_dev database is allowed.');
}
const username = process.env.DEV_ADMIN_USERNAME?.trim();
const password = process.env.DEV_ADMIN_PASSWORD;
if (!username || !password || password.length < 12) throw new Error('Set DEV_ADMIN_USERNAME and DEV_ADMIN_PASSWORD (12+ characters).');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await pool.query(
    `INSERT INTO public.workbench_users (id, username, password_hash, role, status, must_reset_password, display_name)
     VALUES ($1, $2, $3, 'admin', 'active', false, $2) ON CONFLICT (username) DO NOTHING RETURNING id`,
    [randomUUID(), username, await hash(password, 12)],
  );
  console.log(result.rowCount === 1 ? 'Development admin created.' : 'Account exists; no changes made.');
} finally {
  await pool.end();
}
