import { Pool } from './mysql-await-async';

export const pool = new Pool({
  host: (process.env.DB_REMOTE ? 'skyviewcafe.com' : '127.0.0.1'),
  user: 'skyview',
  password: process.env.DB_PWD,
  database: 'skyviewcafe'
});

pool.on('connection', connection => {
  connection.query("SET NAMES 'utf8'");
});

export function logWarning(message: string, notrace = true): void {
  console.warn(message, notrace);
}
