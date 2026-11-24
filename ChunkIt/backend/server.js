// Backend skeleton. DONE for you: DB schema + startup, health check, error handler, server boot.
// TODO: every function/route marked "TO-DO" below. Until implemented, routes answer 501.
// Suggested order: auth -> courses -> assignments -> sub-assignments + recalc -> /upcoming, /overdue.
// Test each route with curl before using it from the frontend (see docs in README / docs/api list).
const os = require('os');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');   // used in auth routes
const jwt = require('jsonwebtoken');  // used in sign() and auth()
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PORT = parseInt(process.env.PORT || '4000', 10);

// ---------- Schema (DONE: created on startup; safe to run repeatedly) ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  color TEXT DEFAULT '#3b82f6'
);
CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_date TIMESTAMPTZ NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','done')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS idx_assignments_user_due ON assignments(user_id, due_date);
CREATE TABLE IF NOT EXISTS sub_assignments (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  is_done BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS notifications_sent (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, type)
);`;

// DONE: retries until Postgres is reachable; an advisory lock stops replicas racing each other.
async function initDb() {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(779000)');
        await client.query(SCHEMA);
        await client.query('SELECT pg_advisory_unlock(779000)');
      } finally {
        client.release();
      }
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`[db] not ready (${err.message}), retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---------- App + helpers ----------
const app = express();
app.use(cors()); // TODO (hardening, optional): restrict origins instead of allowing all
app.use(express.json());

// DONE: lets async route handlers throw; errors go to the error handler at the bottom.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// Placeholder response used by every unimplemented route.
const todo = (what) => (req, res) => res.status(501).json({ error: `TO-DO: ${what}` });

// sign(user) -> JWT string containing the user's id and email, valid for 7 days.
function sign(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

// Auth middleware: protects every route registered after `app.use('/api', auth)`.
// Expects the header "Authorization: Bearer <token>".
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  try {
    const payload = jwt.verify(token, JWT_SECRET); // throws if missing, tampered with, or expired
    req.user = { id: payload.id, email: payload.email };
  } catch {
    return res.status(401).json({ error: 'Invalid or missing token' });
  }
  next(); // token is valid: continue to the route
}

// TO-DO: recalc(assignmentId) - recompute progress/status from sub-tasks
//   1. SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_done) AS done FROM sub_assignments WHERE assignment_id = $1
//   2. If total is 0: return (manual progress/status stay as they are).
//   3. progress = Math.round(100 * done / total)
//   4. status = progress >= 100 ? 'done' : progress > 0 ? 'in_progress' : 'not_started'
//   5. UPDATE assignments SET progress = $1, status = $2 WHERE id = $3
async function recalc(assignmentId) { // eslint-disable-line no-unused-vars
  throw new Error('TO-DO: implement recalc()');
}

// TO-DO: ownsAssignment(id, userId) -> boolean
//   1. SELECT 1 FROM assignments WHERE id = $1 AND user_id = $2
//   2. return rowCount > 0   (used to stop users touching other people's sub-tasks)
async function ownsAssignment(id, userId) { // eslint-disable-line no-unused-vars
  throw new Error('TO-DO: implement ownsAssignment()');
}

// courseOk(courseId, userId) -> true if no course was given, or the course belongs to this user.
// Stops a user attaching an assignment to someone else's course.
async function courseOk(courseId, userId) {
  if (courseId === undefined || courseId === null || courseId === '') return true;
  const { rowCount } = await pool.query('SELECT 1 FROM courses WHERE id = $1 AND user_id = $2', [courseId, userId]);
  return rowCount > 0;
}

// ---------- Health (DONE) ----------
app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', host: os.hostname() }); // hostname shows which replica answered
}));

// ---------- Auth ----------
// POST /api/auth/register  body {email, password} -> 201 {token, user:{id,email}}
app.post('/api/auth/register', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email and a password of at least 6 characters are required' });
  }
  const hash = await bcrypt.hash(password, 10); // 10 = cost factor (2^10 hashing rounds)
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email.toLowerCase().trim(), hash]
    );
    const user = rows[0];
    res.status(201).json({ token: sign(user), user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    throw err; // anything else goes to the error handler (500)
  }
}));

// POST /api/auth/login  body {email, password} -> {token, user}
app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  const user = rows[0];
  // Same message whether the email is unknown or the password is wrong, so nobody can probe which emails exist.
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json({ token: sign(user), user: { id: user.id, email: user.email } });
}));

// Everything below requires a logged-in user (needs auth() above) and is ALWAYS filtered by req.user.id.
app.use('/api', auth);

// ---------- Courses ----------
// GET /api/courses -> course[]  (only the logged-in user's courses)
app.get('/api/courses', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM courses WHERE user_id = $1 ORDER BY name', [req.user.id]);
  res.json(rows);
}));

// POST /api/courses  body {name, code?, color?} -> 201 course
app.post('/api/courses', wrap(async (req, res) => {
  const { name, code, color } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Course name is required' });
  const { rows } = await pool.query(
    'INSERT INTO courses (user_id, name, code, color) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.user.id, name, code || null, color || '#3b82f6']
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/courses/:id  body any of {name, code, color} -> course
// COALESCE($n, col) keeps the current value for any field that wasn't sent (undefined -> NULL).
app.put('/api/courses/:id', wrap(async (req, res) => {
  const { name, code, color } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE courses SET name = COALESCE($1, name), code = COALESCE($2, code), color = COALESCE($3, color)
      WHERE id = $4 AND user_id = $5 RETURNING *`,
    [name, code, color, req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Course not found' });
  res.json(rows[0]);
}));

// DELETE /api/courses/:id -> 204  (ON DELETE CASCADE also removes the course's assignments)
app.delete('/api/courses/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM courses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Course not found' });
  res.status(204).end();
}));

// ---------- Assignments ----------
// Shared query: assignment + course info + sub-task counts. Reuse it in the GET routes below.
const SELECT = `
  SELECT a.*, c.name AS course_name, c.code AS course_code, c.color AS course_color,
         (SELECT COUNT(*)::int FROM sub_assignments s WHERE s.assignment_id = a.id) AS sub_total,
         (SELECT COUNT(*)::int FROM sub_assignments s WHERE s.assignment_id = a.id AND s.is_done) AS sub_done
    FROM assignments a LEFT JOIN courses c ON c.id = a.course_id
   WHERE a.user_id = $1`;

// NOTE: /upcoming and /overdue must be declared BEFORE /:id or "upcoming" is treated as an id.

// GET /api/assignments/upcoming?days=14 -> unfinished assignments due in the next N days (dashboard)
app.get('/api/assignments/upcoming', wrap(async (req, res) => {
  const days = parseInt(req.query.days, 10) || 14;
  const { rows } = await pool.query(
    `${SELECT} AND a.status <> 'done' AND a.due_date >= now()
       AND a.due_date <= now() + $2::int * interval '1 day' ORDER BY a.due_date`,
    [req.user.id, days]
  );
  res.json(rows);
}));

// GET /api/assignments/overdue -> unfinished assignments whose due date has passed (dashboard)
app.get('/api/assignments/overdue', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `${SELECT} AND a.status <> 'done' AND a.due_date < now() ORDER BY a.due_date`,
    [req.user.id]
  );
  res.json(rows);
}));

// GET /api/assignments  optional ?course_id=&status=&from=&to= -> assignment[]
// Builds the WHERE clause from whichever filters were sent. The VALUES always go in params as $n;
// only fixed SQL text written here is ever added to the query string.
app.get('/api/assignments', wrap(async (req, res) => {
  const { course_id, status, from, to } = req.query;
  let sql = SELECT;
  const params = [req.user.id];
  const add = (condition, value) => {
    params.push(value);
    sql += ` AND ${condition} $${params.length}`; // e.g. " AND a.course_id = $2"
  };
  if (course_id) add('a.course_id =', course_id);
  if (status) add('a.status =', status);
  if (from) add('a.due_date >=', from);
  if (to) add('a.due_date <=', to);
  const { rows } = await pool.query(sql + ' ORDER BY a.due_date', params);
  res.json(rows);
}));

// GET /api/assignments/:id -> assignment (with course info + sub-task counts) + its sub_assignments[]
app.get('/api/assignments/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(`${SELECT} AND a.id = $2`, [req.user.id, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Assignment not found' });
  const subs = await pool.query('SELECT * FROM sub_assignments WHERE assignment_id = $1 ORDER BY id', [req.params.id]);
  res.json({ ...rows[0], sub_assignments: subs.rows });
}));

// POST /api/assignments  body {title, due_date, course_id?, description?, priority?, status?, progress?} -> 201
app.post('/api/assignments', wrap(async (req, res) => {
  const { title, due_date, course_id, description, priority, status, progress } = req.body || {};
  if (!title || !due_date) return res.status(400).json({ error: 'Title and due date are required' });
  if (!(await courseOk(course_id, req.user.id))) return res.status(400).json({ error: 'Invalid course' });
  // Missing priority/status/progress arrive as NULL; COALESCE swaps in the defaults.
  // Bad values (priority 'urgent', progress 150, due_date 'soon') are rejected by the DB -> 400 via the error handler.
  const { rows } = await pool.query(
    `INSERT INTO assignments (user_id, course_id, title, description, due_date, priority, status, progress)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'medium'), COALESCE($7, 'not_started'), COALESCE($8, 0))
     RETURNING *`,
    [req.user.id, course_id || null, title, description || null, due_date, priority, status, progress]
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/assignments/:id  body any of the fields above -> assignment (partial update, like courses)
app.put('/api/assignments/:id', wrap(async (req, res) => {
  const { title, description, due_date, priority, status, progress, course_id } = req.body || {};
  if (!(await courseOk(course_id, req.user.id))) return res.status(400).json({ error: 'Invalid course' });
  const { rows } = await pool.query(
    `UPDATE assignments SET
       title = COALESCE($1, title), description = COALESCE($2, description), due_date = COALESCE($3, due_date),
       priority = COALESCE($4, priority), status = COALESCE($5, status), progress = COALESCE($6, progress),
       course_id = COALESCE($7, course_id)
     WHERE id = $8 AND user_id = $9 RETURNING *`,
    [title, description, due_date, priority, status, progress, course_id || null, req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Assignment not found' });
  res.json(rows[0]);
}));

// DELETE /api/assignments/:id -> 204  (its sub-tasks and sent-notification records cascade)
app.delete('/api/assignments/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM assignments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Assignment not found' });
  res.status(204).end();
}));

// ---------- Sub-assignments ----------
// TO-DO: ownership guard for everything under /api/assignments/:id/subs
//   1. if (!(await ownsAssignment(req.params.id, req.user.id))) return 404 { error: 'Assignment not found' }
//   2. otherwise next().  (Replace the 501 below with this logic.)
app.use('/api/assignments/:id/subs', (req, res) => res.status(501).json({ error: 'TO-DO: sub-assignment ownership guard' }));

// TO-DO: GET /api/assignments/:id/subs -> sub_assignment[]
//   1. SELECT * FROM sub_assignments WHERE assignment_id = $1 ORDER BY id
app.get('/api/assignments/:id/subs', todo('list sub-assignments'));

// TO-DO: POST /api/assignments/:id/subs  body {title} -> 201 sub_assignment
//   1. 400 if title missing; INSERT INTO sub_assignments (assignment_id, title) ... RETURNING *
//   2. await recalc(req.params.id) so the parent progress updates.
app.post('/api/assignments/:id/subs', todo('create sub-assignment'));

// TO-DO: PUT /api/assignments/:id/subs/:subId  body {title?, is_done?} -> sub_assignment
//   1. UPDATE ... SET title = COALESCE($1, title), is_done = COALESCE($2, is_done)
//      WHERE id = $3 AND assignment_id = $4 RETURNING *   (is_done must be a boolean; otherwise pass null)
//   2. 404 if no row; then await recalc(req.params.id).
app.put('/api/assignments/:id/subs/:subId', todo('update sub-assignment'));

// TO-DO: DELETE /api/assignments/:id/subs/:subId -> 204
//   1. DELETE FROM sub_assignments WHERE id = $1 AND assignment_id = $2; 404 if rowCount is 0.
//   2. await recalc(req.params.id).
app.delete('/api/assignments/:id/subs/:subId', todo('delete sub-assignment'));

// ---------- Errors (DONE) ----------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err.message);
  // 23514 CHECK failed, 22007 bad date format, 22008 date out of range, 22P02 bad number, 22003 number too big
  if (['23514', '22007', '22008', '22P02', '22003'].includes(err.code)) return res.status(400).json({ error: 'Invalid field value' });
  res.status(500).json({ error: 'Internal server error' });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Backend listening on ${PORT}`)))
  .catch((err) => { console.error('Could not initialise database:', err.message); process.exit(1); });
