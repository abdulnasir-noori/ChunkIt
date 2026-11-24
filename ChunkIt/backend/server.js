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

// TO-DO: courseOk(courseId, userId) -> boolean
//   1. If courseId is empty/null, return true (assignment without a course is allowed).
//   2. SELECT 1 FROM courses WHERE id = $1 AND user_id = $2; return rowCount > 0
async function courseOk(courseId, userId) { // eslint-disable-line no-unused-vars
  throw new Error('TO-DO: implement courseOk()');
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
// TO-DO: GET /api/courses -> course[]
//   1. SELECT * FROM courses WHERE user_id = $1 ORDER BY name
app.get('/api/courses', todo('list courses'));

// TO-DO: POST /api/courses  body {name, code?, color?} -> 201 course
//   1. 400 if name is missing.
//   2. INSERT (user_id, name, code, color) with default color '#3b82f6' when none is given; RETURNING *
app.post('/api/courses', todo('create course'));

// TO-DO: PUT /api/courses/:id  body any of {name, code, color} -> course
//   1. UPDATE ... SET col = COALESCE($n, col) ... WHERE id = $4 AND user_id = $5 RETURNING *
//   2. 404 if no row came back.
app.put('/api/courses/:id', todo('update course'));

// TO-DO: DELETE /api/courses/:id -> 204
//   1. DELETE FROM courses WHERE id = $1 AND user_id = $2 (ON DELETE CASCADE removes its assignments)
//   2. 404 if rowCount is 0.
app.delete('/api/courses/:id', todo('delete course'));

// ---------- Assignments ----------
// Shared query: assignment + course info + sub-task counts. Reuse it in the GET routes below.
const SELECT = `
  SELECT a.*, c.name AS course_name, c.code AS course_code, c.color AS course_color,
         (SELECT COUNT(*)::int FROM sub_assignments s WHERE s.assignment_id = a.id) AS sub_total,
         (SELECT COUNT(*)::int FROM sub_assignments s WHERE s.assignment_id = a.id AND s.is_done) AS sub_done
    FROM assignments a LEFT JOIN courses c ON c.id = a.course_id
   WHERE a.user_id = $1`;

// NOTE: /upcoming and /overdue must be declared BEFORE /:id or "upcoming" is treated as an id.

// TO-DO: GET /api/assignments/upcoming?days=14 -> assignment[]
//   1. days = parseInt(req.query.days) || 14
//   2. `${SELECT} AND a.status <> 'done' AND a.due_date >= now() AND a.due_date <= now() + ($2 || ' days')::interval ORDER BY a.due_date`
//   3. params: [req.user.id, String(days)]
app.get('/api/assignments/upcoming', todo('upcoming assignments'));

// TO-DO: GET /api/assignments/overdue -> assignment[]
//   1. `${SELECT} AND a.status <> 'done' AND a.due_date < now() ORDER BY a.due_date`
app.get('/api/assignments/overdue', todo('overdue assignments'));

// TO-DO: GET /api/assignments  optional ?course_id=&status=&from=&to= -> assignment[]
//   1. Start from SELECT and params = [req.user.id].
//   2. For each filter present, push the value to params and append e.g. ` AND a.course_id = $${params.length}`.
//      (from/to filter a.due_date with >= and <=; the calendar uses them.)
//   3. Append ' ORDER BY a.due_date'. Never build SQL by concatenating user values - always use $n params.
app.get('/api/assignments', todo('list assignments'));

// TO-DO: GET /api/assignments/:id -> assignment + sub_assignments[]
//   1. `${SELECT} AND a.id = $2`; 404 if missing.
//   2. Also SELECT * FROM sub_assignments WHERE assignment_id = $1 ORDER BY id; return { ...row, sub_assignments }.
app.get('/api/assignments/:id', todo('get assignment'));

// TO-DO: POST /api/assignments  body {title, due_date, course_id?, description?, priority?, status?, progress?} -> 201
//   1. 400 if title or due_date missing.
//   2. 400 'Invalid course' if !(await courseOk(course_id, req.user.id)).
//   3. INSERT with COALESCE defaults: priority 'medium', status 'not_started', progress 0; RETURNING *
//   4. Invalid enum/date values throw DB errors; the error handler below turns those into 400.
app.post('/api/assignments', todo('create assignment'));

// TO-DO: PUT /api/assignments/:id  body any of the fields above -> assignment
//   1. If course_id is given, validate it with courseOk().
//   2. UPDATE ... SET col = COALESCE($n, col) ... WHERE id = $8 AND user_id = $9 RETURNING *
//   3. 404 if no row came back.
app.put('/api/assignments/:id', todo('update assignment'));

// TO-DO: DELETE /api/assignments/:id -> 204
//   1. DELETE FROM assignments WHERE id = $1 AND user_id = $2 (sub-tasks cascade); 404 if rowCount is 0.
app.delete('/api/assignments/:id', todo('delete assignment'));

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
  if (['23514', '22007', '22P02', '22003'].includes(err.code)) return res.status(400).json({ error: 'Invalid field value' });
  res.status(500).json({ error: 'Internal server error' });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Backend listening on ${PORT}`)))
  .catch((err) => { console.error('Could not initialise database:', err.message); process.exit(1); });
