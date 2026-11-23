// Whole frontend in one file: API helper, login/register, dashboard, assignments (with sub-tasks
// and progress bars), courses, and a month calendar. No router: the nav just switches `view`.
import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// ---------- API helper ----------
async function api(path, method = 'GET', body) {
  const token = localStorage.getItem('token');
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { localStorage.clear(); location.reload(); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// Loads a list from the API; returns [data, reload, error].
function useFetch(path) {
  const [data, setData] = useState([]);
  const [error, setError] = useState('');
  const load = useCallback(
    () => api(path).then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)),
    [path]
  );
  useEffect(() => { load(); }, [load]);
  return [data, load, error];
}

const statusFor = (p) => (p >= 100 ? 'done' : p > 0 ? 'in_progress' : 'not_started');
const Bar = ({ value }) => (
  <div className="bar" title={`${value}%`}><div className={value >= 100 ? 'full' : ''} style={{ width: `${value}%` }} /></div>
);

// ---------- Login / register ----------
function AuthForm({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ email: '', password: '' });
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      const d = await api(`/auth/${mode}`, 'POST', f);
      localStorage.setItem('token', d.token);
      localStorage.setItem('user', JSON.stringify(d.user));
      onAuth(d.user);
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <form onSubmit={submit} className="stack" style={{ maxWidth: 320 }}>
      <h2>{mode === 'login' ? 'Log in' : 'Create account'}</h2>
      <input type="email" placeholder="Email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <input type="password" placeholder="Password (min 6 chars)" required minLength={6} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      {err && <div className="err">{err}</div>}
      <button type="submit">{mode === 'login' ? 'Log in' : 'Register'}</button>
      <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'}
      </button>
    </form>
  );
}

// ---------- One assignment card (edit status/progress, sub-tasks, delete) ----------
function Card({ a, onChange }) {
  const [open, setOpen] = useState(false);
  const [subs, setSubs] = useState([]);
  const [newSub, setNewSub] = useState('');

  const loadSubs = () => api(`/assignments/${a.id}/subs`).then(setSubs);
  useEffect(() => { if (open) loadSubs(); }, [open]); // eslint-disable-line

  const update = async (fields) => { await api(`/assignments/${a.id}`, 'PUT', fields); onChange(); };
  const remove = async () => {
    if (confirm(`Delete "${a.title}"?`)) { await api(`/assignments/${a.id}`, 'DELETE'); onChange(); }
  };
  const subAction = async (fn) => { await fn(); await loadSubs(); onChange(); };

  return (
    <div className="card" style={{ borderLeftColor: a.course_color || '#999' }}>
      <div className="row">
        <strong>{a.title}</strong>
        {a.course_code && <small className="muted">{a.course_code}</small>}
        <span className={`tag ${a.priority}`}>{a.priority}</span>
        <select
          value={a.status}
          onChange={(e) => update({ status: e.target.value, ...(e.target.value === 'done' && { progress: 100 }) })}
        >
          <option value="not_started">Not started</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
        </select>
        <button onClick={() => setOpen(!open)}>Sub-tasks ({a.sub_done}/{a.sub_total})</button>
        <button onClick={remove}>Delete</button>
      </div>
      <small className="muted">Due {new Date(a.due_date).toLocaleString()}</small>
      <Bar value={a.progress} />

      {/* Manual progress only when there are no sub-tasks; otherwise it is computed from them */}
      {a.sub_total === 0 && (
        <input
          key={a.progress}
          type="range" min="0" max="100" step="5" defaultValue={a.progress}
          onPointerUp={(e) => { const p = +e.target.value; update({ progress: p, status: statusFor(p) }); }}
        />
      )}

      {open && (
        <div className="stack" style={{ marginTop: 8 }}>
          {subs.map((s) => (
            <div className="row" key={s.id}>
              <input type="checkbox" checked={s.is_done}
                onChange={() => subAction(() => api(`/assignments/${a.id}/subs/${s.id}`, 'PUT', { is_done: !s.is_done }))} />
              <span style={{ textDecoration: s.is_done ? 'line-through' : 'none' }}>{s.title}</span>
              <button onClick={() => subAction(() => api(`/assignments/${a.id}/subs/${s.id}`, 'DELETE'))}>x</button>
            </div>
          ))}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              subAction(() => api(`/assignments/${a.id}/subs`, 'POST', { title: newSub })).then(() => setNewSub(''));
            }}
          >
            <input placeholder="New sub-task" value={newSub} onChange={(e) => setNewSub(e.target.value)} required />
            <button type="submit">Add</button>
          </form>
        </div>
      )}
    </div>
  );
}

const Section = ({ title, items, empty, onChange }) => (
  <section style={{ marginBottom: 24 }}>
    <h3>{title}</h3>
    {items.length === 0 && <p className="muted">{empty}</p>}
    {items.map((a) => <Card key={a.id} a={a} onChange={onChange} />)}
  </section>
);

// ---------- Views ----------
function Dashboard() {
  const [upcoming, reloadU, e1] = useFetch('/assignments/upcoming?days=14');
  const [overdue, reloadO, e2] = useFetch('/assignments/overdue');
  const reload = () => { reloadU(); reloadO(); };
  return (
    <>
      <h2>Dashboard</h2>
      {(e1 || e2) && <p className="err">{e1 || e2}</p>}
      <Section title="Overdue" items={overdue} empty="Nothing overdue." onChange={reload} />
      <Section title="Due in the next 14 days" items={upcoming} empty="Nothing due soon." onChange={reload} />
    </>
  );
}

function Assignments() {
  const [courses] = useFetch('/courses');
  const [filter, setFilter] = useState('');
  const [items, reload, err] = useFetch('/assignments' + (filter ? `?course_id=${filter}` : ''));
  const blank = { title: '', course_id: '', due_date: '', priority: 'medium' };
  const [form, setForm] = useState(blank);
  const [formErr, setFormErr] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function add(e) {
    e.preventDefault();
    setFormErr('');
    try {
      await api('/assignments', 'POST', {
        ...form, course_id: form.course_id || null, due_date: new Date(form.due_date).toISOString(),
      });
      setForm(blank);
      reload();
    } catch (e2) { setFormErr(e2.message); }
  }

  return (
    <>
      <h2>Assignments</h2>
      <form onSubmit={add} className="row" style={{ marginBottom: 16 }}>
        <input placeholder="Title" required value={form.title} onChange={set('title')} />
        <select value={form.course_id} onChange={set('course_id')}>
          <option value="">No course</option>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.code || c.name}</option>)}
        </select>
        <input type="datetime-local" required value={form.due_date} onChange={set('due_date')} />
        <select value={form.priority} onChange={set('priority')}>
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select>
        <button type="submit">Add</button>
      </form>
      {(formErr || err) && <p className="err">{formErr || err}</p>}
      <div className="row" style={{ marginBottom: 12 }}>
        <label>Filter by course:</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All</option>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.code || c.name}</option>)}
        </select>
      </div>
      {items.length === 0 && <p className="muted">No assignments yet.</p>}
      {items.map((a) => <Card key={a.id} a={a} onChange={reload} />)}
    </>
  );
}

function Courses() {
  const [courses, reload, err] = useFetch('/courses');
  const [f, setF] = useState({ name: '', code: '', color: '#3b82f6' });

  async function add(e) {
    e.preventDefault();
    await api('/courses', 'POST', f);
    setF({ name: '', code: '', color: '#3b82f6' });
    reload();
  }
  async function remove(c) {
    if (confirm(`Delete ${c.name} and all of its assignments?`)) { await api(`/courses/${c.id}`, 'DELETE'); reload(); }
  }

  return (
    <>
      <h2>Courses</h2>
      <form onSubmit={add} className="row" style={{ marginBottom: 16 }}>
        <input placeholder="Course name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input placeholder="Code (e.g. ECE1779)" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} />
        <button type="submit">Add</button>
      </form>
      {err && <p className="err">{err}</p>}
      {courses.map((c) => (
        <div className="row" key={c.id} style={{ marginBottom: 6 }}>
          <span style={{ width: 12, height: 12, background: c.color, borderRadius: 6 }} />
          {c.code ? `${c.code} - ` : ''}{c.name}
          <button onClick={() => remove(c)}>Delete</button>
        </div>
      ))}
    </>
  );
}

function CalendarView() {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const from = month.toISOString();
  const to = new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString();
  const [items] = useFetch(`/assignments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [...Array(month.getDay()).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const shift = (n) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  return (
    <>
      <h2>
        <button onClick={() => shift(-1)}>&lt;</button>{' '}
        {month.toLocaleString('default', { month: 'long', year: 'numeric' })}{' '}
        <button onClick={() => shift(1)}>&gt;</button>
      </h2>
      <div className="grid7">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <strong key={d}>{d}</strong>)}
        {cells.map((day, i) => (
          <div className="cell" key={i}>
            {day}
            {day && items.filter((a) => new Date(a.due_date).getDate() === day).map((a) => (
              <div className="chip" key={a.id} style={{ background: a.course_color || '#999' }} title={a.title}>{a.title}</div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- App shell ----------
function App() {
  const [user, setUser] = useState(() => (localStorage.getItem('token') ? JSON.parse(localStorage.getItem('user') || 'null') : null));
  const [view, setView] = useState('dashboard');

  if (!user) return <AuthForm onAuth={setUser} />;

  const views = { dashboard: Dashboard, assignments: Assignments, courses: Courses, calendar: CalendarView };
  const View = views[view];
  return (
    <>
      <nav>
        <strong>Assignment Tracker</strong>
        {Object.keys(views).map((v) => (
          <button key={v} className={v === view ? 'active' : ''} onClick={() => setView(v)}>
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
        <span className="spacer">
          {user.email} <button onClick={() => { localStorage.clear(); setUser(null); }}>Log out</button>
        </span>
      </nav>
      <View />
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
