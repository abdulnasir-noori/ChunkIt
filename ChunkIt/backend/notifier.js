// Background worker skeleton: emails users about assignments due soon.
// Run as ONE replica (see docker-stack.yml). DONE: setup, scheduling. TO-DO: sendEmail() and run().
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const WINDOW_HOURS = parseInt(process.env.NOTIFY_WINDOW_HOURS || '48', 10);
const EVERY_MINUTES = parseInt(process.env.NOTIFY_INTERVAL_MINUTES || '15', 10);
const LOCK_ID = 779001; // arbitrary constant shared by all notifier instances

// TO-DO: sendEmail(to, subject, text)
//   1. If EMAIL_MODE !== 'resend' or RESEND_API_KEY is empty: console.log the email and return (demo fallback).
//   2. Otherwise POST https://api.resend.com/emails (Node 20 has global fetch):
//        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }
//        body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, text })
//   3. If !res.ok, throw new Error(`Resend ${res.status}: ${await res.text()}`) so run() can undo its reservation.
async function sendEmail(to, subject, text) { // eslint-disable-line no-unused-vars
  //Log mode
  if (process.env.EMAIL_MODE!=='resend' || !process.env.RESEND_API_KEY) {
    console.log(`[email:log] to=${to} subject="${subject}"\n${text}`);
    return;
  }

  //Resend mode
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Assignment Tracker <onboarding@resend.dev>',
      to,        // a string or an array of addresses
      subject,
      text,      // plain-text body; use `html` instead for formatted emails
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}

// TO-DO: run() - one deadline check
//   1. client = await pool.connect(); release it in a finally block.
//   2. Take the lock: SELECT pg_try_advisory_lock($1) AS got. If !got, log and return. Always pg_advisory_unlock in finally.
//   3. Find assignments due soon that were not reminded yet:
//        SELECT a.id, a.title, a.due_date, u.email, c.name AS course_name
//          FROM assignments a JOIN users u ON u.id = a.user_id LEFT JOIN courses c ON c.id = a.course_id
//         WHERE a.status <> 'done' AND a.due_date > now()
//           AND a.due_date <= now() + ($1 || ' hours')::interval
//           AND NOT EXISTS (SELECT 1 FROM notifications_sent n WHERE n.assignment_id = a.id AND n.type = 'due_soon')
//      with params [String(WINDOW_HOURS)].
//   4. For each row, reserve it first:
//        INSERT INTO notifications_sent (assignment_id, type) VALUES ($1, 'due_soon') ON CONFLICT DO NOTHING RETURNING id
//      If nothing was inserted, skip it (another run already handled it).
//   5. try { await sendEmail(...) } catch { DELETE the reservation row so it is retried next run; log the error }.
//   6. Wrap everything in try/catch and log failures; the interval below keeps running regardless.
async function run() {
  client = await pool.connect();

  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_ID]);
    if (!lock.got) {
      console.log('[notifier] another instance is running, skipping');
      return;
    }
    try {
      const { rows } = await client.query(
      `SELECT a.id, a.title, a.due_date, u.email, c.name AS course_name
          FROM assignments a
          JOIN users u ON u.id = a.user_id
          LEFT JOIN courses c ON c.id = a.course_id
        WHERE a.status <> 'done'
          AND a.due_date > now()
          AND a.due_date <= now() + ($1 || ' hours')::interval
          AND NOT EXISTS (
            SELECT 1 FROM notifications_sent n
              WHERE n.assignment_id = a.id AND n.type = 'due_soon')`,
      [String(WINDOW_HOURS)]);

      for (const a of rows) {
        const ins = await client.query(
          `INSERT INTO notifications_sent (assignment_id, type)
           VALUES ($1, 'due_soon')
           ON CONFLICT DO NOTHING RETURNING id`,
          [a.id]);
        if (!ins.rowCount) continue;   // someone else already reserved it

        try {
          await sendEmail(
            a.email,
            `Due soon: ${a.title}`,
            `Reminder: "${a.title}"${a.course_name ? ` (${a.course_name})` : ''} is due ${new Date(a.due_date).toLocaleString('en-CA', { timeZone: 'America/Toronto' })}.`);
          console.log(`[notifier] reminder sent for assignment ${a.id}`);
        } catch (err) {
          await client.query('DELETE FROM notifications_sent WHERE id = $1', [ins.rows[0].id]);
          console.error(`[notifier] send failed for assignment ${a.id}: ${err.message}`);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } catch (err) {
    console.error('[notifier] run failed:', err.message);
  } finally {
    client.release();
  }
}

console.log(`[notifier] started: window=${WINDOW_HOURS}h, every ${EVERY_MINUTES} min`);
setTimeout(run, 15000); // short delay so the backend can create the tables first
setInterval(run, EVERY_MINUTES * 60 * 1000);
