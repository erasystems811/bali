const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/sop-uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Invoices have no stored PDF (the WhatsApp-sent copy is gone once sent) --
// n8n's invoice-pdf webhook (n8n/_src/invoice-pdf-view-code.js) regenerates
// one on demand from the invoice's own data. Env-configurable since this is
// the second time the public n8n address has changed.
const N8N_PUBLIC_URL = process.env.N8N_PUBLIC_URL || 'https://n8n.erasystems.com.ng';

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'n8n',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'bali',
});

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
  })
);

const upload = multer({ dest: path.join(UPLOAD_DIR, '.tmp'), limits: { fileSize: 25 * 1024 * 1024 } });

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function layout(title, body, opts = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Bali Dashboard</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#f5f6f8;color:#1c2530}
  header{background:#173047;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap}
  header a{color:#fff;text-decoration:none;margin-right:14px;font-size:14px}
  header .brand{font-weight:700;font-size:16px;margin-right:24px}
  nav{background:#20405c;padding:8px 20px;display:flex;flex-wrap:wrap;gap:4px}
  nav a{color:#dce8f2;text-decoration:none;padding:6px 12px;border-radius:6px;font-size:13px}
  nav a.active{background:#0d84ff;color:#fff}
  main{padding:20px;max-width:1100px;margin:0 auto}
  table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  th,td{padding:8px 10px;border-bottom:1px solid #e6e9ee;text-align:left;font-size:13px;vertical-align:top}
  th{background:#eef1f5;font-weight:600}
  tr:hover td{background:#f9fbff}
  .card{background:#fff;padding:18px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);max-width:480px;margin:40px auto}
  input,select,textarea{width:100%;padding:8px;margin:6px 0 14px;border:1px solid #ccd3da;border-radius:6px;font-size:14px;box-sizing:border-box}
  label{font-size:13px;font-weight:600;color:#42505e}
  button{background:#0d84ff;color:#fff;border:none;padding:9px 16px;border-radius:6px;font-size:14px;cursor:pointer}
  button.danger{background:#d64545}
  .btn-link{display:inline-block;background:#0d84ff;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px;margin-bottom:14px}
  .row-actions a{margin-right:10px;font-size:12px}
  .error{background:#fde2e1;color:#9c1c13;padding:10px 14px;border-radius:6px;margin-bottom:14px;font-size:13px}
  .muted{color:#6b7785;font-size:12px}
  form.inline{display:inline}
</style></head>
<body>
${opts.bare ? '' : header(opts.active)}
<main>${body}</main>
</body></html>`;
}

const TABS = [
  { key: 'contacts', label: 'Contacts' },
  { key: 'knowledge_base', label: 'Knowledge Base' },
  { key: 'sops', label: 'SOPs' },
  { key: 'bookings', label: 'Bookings' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'pending_questions', label: 'Pending Questions' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'contracts', label: 'Contracts' },
];

function header(active) {
  return `<header>
    <div><span class="brand">Bali Dashboard</span></div>
    <div><a href="/dashboard/account">Change password</a><a href="/dashboard/logout">Log out</a></div>
  </header>
  <nav>${TABS.map((t) => `<a class="${active === t.key ? 'active' : ''}" href="/dashboard/${t.key}">${esc(t.label)}</a>`).join('')}</nav>`;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/dashboard/login');
}

// ---------- auth ----------

app.get('/dashboard/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard/');
  const err = req.query.err ? `<div class="error">${esc(req.query.err)}</div>` : '';
  res.send(
    layout(
      'Log in',
      `<div class="card"><h2>Bali Dashboard</h2>${err}
      <form method="post" action="/dashboard/login">
        <label>Username</label><input name="username" autocomplete="username" required>
        <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Log in</button>
      </form></div>`,
      { bare: true }
    )
  );
});

app.post('/dashboard/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT id, password_hash FROM dashboard_users WHERE username = $1', [username]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password || '', user.password_hash));
    if (!ok) return res.redirect('/dashboard/login?err=' + encodeURIComponent('Incorrect username or password'));
    req.session.regenerate((e) => {
      if (e) return res.redirect('/dashboard/login?err=' + encodeURIComponent('Login failed, try again'));
      req.session.userId = user.id;
      req.session.username = username;
      res.redirect('/dashboard/');
    });
  } catch (e) {
    console.error('login error', e);
    res.redirect('/dashboard/login?err=' + encodeURIComponent('Server error, try again'));
  }
});

app.get('/dashboard/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/dashboard/login'));
});

app.get('/dashboard/account', requireAuth, (req, res) => {
  const err = req.query.err ? `<div class="error">${esc(req.query.err)}</div>` : '';
  const ok = req.query.ok ? `<div class="card" style="background:#e3f6e6;color:#1c6b2e;max-width:480px;margin:14px auto">Password updated.</div>` : '';
  res.send(
    layout(
      'Account',
      `${ok}<div class="card"><h2>Change password</h2>${err}
      <form method="post" action="/dashboard/account">
        <label>Current password</label><input name="current" type="password" required>
        <label>New password</label><input name="next" type="password" minlength="6" required>
        <button type="submit">Update password</button>
      </form></div>`,
      { active: null }
    )
  );
});

app.post('/dashboard/account', requireAuth, async (req, res) => {
  const { current, next } = req.body;
  try {
    const { rows } = await pool.query('SELECT password_hash FROM dashboard_users WHERE id = $1', [req.session.userId]);
    const ok = rows[0] && (await bcrypt.compare(current || '', rows[0].password_hash));
    if (!ok) return res.redirect('/dashboard/account?err=' + encodeURIComponent('Current password is incorrect'));
    if (!next || next.length < 6) return res.redirect('/dashboard/account?err=' + encodeURIComponent('New password must be at least 6 characters'));
    const hash = await bcrypt.hash(next, 12);
    await pool.query('UPDATE dashboard_users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
    res.redirect('/dashboard/account?ok=1');
  } catch (e) {
    console.error('account update error', e);
    res.redirect('/dashboard/account?err=' + encodeURIComponent('Server error, try again'));
  }
});

app.get('/dashboard/', requireAuth, (req, res) => res.redirect('/dashboard/contacts'));

// ---------- contacts (CRUD) ----------

const ROLE_OPTIONS = [
  'customer', 'pm', 'lawyer', 'hr', 'procurement', 'accounts', 'event_assistant', 'security',
  'supervisor', 'facility_manager', 'staff', 'vendor', 'floor_manager', 'stage_manager', 'bar_lead', 'social_media_manager',
];

app.get('/dashboard/contacts', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, phone_number, name, role, permission_level, tags, created_at FROM contacts ORDER BY created_at DESC');
  const body = `<a class="btn-link" href="/dashboard/contacts/new">+ Add contact</a>
  <table><tr><th>Name</th><th>Phone</th><th>Role</th><th>Permission</th><th>Tags</th><th>Created</th><th></th></tr>
  ${rows
    .map(
      (r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.phone_number)}</td><td>${esc(r.role)}</td><td>${esc(r.permission_level)}</td><td>${esc((r.tags || []).join(', '))}</td><td class="muted">${esc(fmtDate(r.created_at))}</td>
      <td class="row-actions"><a href="/dashboard/contacts/${r.id}/edit">Edit</a>${deleteForm('contacts', r.id)}</td></tr>`
    )
    .join('')}</table>`;
  res.send(layout('Contacts', body, { active: 'contacts' }));
});

function contactForm(action, c = {}) {
  return `<div class="card" style="max-width:480px"><h2>${c.id ? 'Edit' : 'Add'} contact</h2>
  <form method="post" action="${action}">
    <label>Name</label><input name="name" value="${esc(c.name)}">
    <label>Phone number</label><input name="phone_number" value="${esc(c.phone_number)}">
    <label>Role</label><select name="role"><option value="">(none)</option>${ROLE_OPTIONS.map((r) => `<option value="${r}" ${c.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <label>Permission level</label><input name="permission_level" value="${esc(c.permission_level)}">
    <label>Tags (comma separated)</label><input name="tags" value="${esc((c.tags || []).join(', '))}">
    <button type="submit">Save</button>
  </form></div>`;
}

app.get('/dashboard/contacts/new', requireAuth, (req, res) => res.send(layout('Add contact', contactForm('/dashboard/contacts/new'), { active: 'contacts' })));

app.post('/dashboard/contacts/new', requireAuth, async (req, res) => {
  const { name, phone_number, role, permission_level, tags } = req.body;
  const tagArr = (tags || '').split(',').map((s) => s.trim()).filter(Boolean);
  await pool.query('INSERT INTO contacts (name, phone_number, role, permission_level, tags) VALUES ($1,$2,$3,$4,$5)', [
    name || null, phone_number || null, role || null, permission_level || null, tagArr.length ? tagArr : null,
  ]);
  res.redirect('/dashboard/contacts');
});

app.get('/dashboard/contacts/:id/edit', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).send(layout('Not found', 'Contact not found', { active: 'contacts' }));
  res.send(layout('Edit contact', contactForm(`/dashboard/contacts/${req.params.id}/edit`, rows[0]), { active: 'contacts' }));
});

app.post('/dashboard/contacts/:id/edit', requireAuth, async (req, res) => {
  const { name, phone_number, role, permission_level, tags } = req.body;
  const tagArr = (tags || '').split(',').map((s) => s.trim()).filter(Boolean);
  await pool.query('UPDATE contacts SET name=$1, phone_number=$2, role=$3, permission_level=$4, tags=$5 WHERE id=$6', [
    name || null, phone_number || null, role || null, permission_level || null, tagArr.length ? tagArr : null, req.params.id,
  ]);
  res.redirect('/dashboard/contacts');
});

app.post('/dashboard/contacts/:id/delete', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
  res.redirect('/dashboard/contacts');
});

// ---------- knowledge_base (CRUD) ----------

app.get('/dashboard/knowledge_base', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM knowledge_base ORDER BY last_updated DESC NULLS LAST');
  const body = `<a class="btn-link" href="/dashboard/knowledge_base/new">+ Add entry</a>
  <table><tr><th>Question</th><th>Answer</th><th>Last updated</th><th></th></tr>
  ${rows
    .map(
      (r) => `<tr><td>${esc(r.question)}</td><td>${esc(r.answer)}</td><td class="muted">${esc(fmtDate(r.last_updated))}</td>
      <td class="row-actions"><a href="/dashboard/knowledge_base/${r.id}/edit">Edit</a>${deleteForm('knowledge_base', r.id)}</td></tr>`
    )
    .join('')}</table>`;
  res.send(layout('Knowledge Base', body, { active: 'knowledge_base' }));
});

function kbForm(action, k = {}) {
  return `<div class="card" style="max-width:560px"><h2>${k.id ? 'Edit' : 'Add'} entry</h2>
  <form method="post" action="${action}">
    <label>Question</label><textarea name="question" rows="2">${esc(k.question)}</textarea>
    <label>Answer</label><textarea name="answer" rows="5">${esc(k.answer)}</textarea>
    <button type="submit">Save</button>
  </form></div>`;
}

app.get('/dashboard/knowledge_base/new', requireAuth, (req, res) => res.send(layout('Add entry', kbForm('/dashboard/knowledge_base/new'), { active: 'knowledge_base' })));

app.post('/dashboard/knowledge_base/new', requireAuth, async (req, res) => {
  await pool.query('INSERT INTO knowledge_base (question, answer, last_updated) VALUES ($1,$2, now())', [req.body.question || null, req.body.answer || null]);
  res.redirect('/dashboard/knowledge_base');
});

app.get('/dashboard/knowledge_base/:id/edit', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM knowledge_base WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).send(layout('Not found', 'Entry not found', { active: 'knowledge_base' }));
  res.send(layout('Edit entry', kbForm(`/dashboard/knowledge_base/${req.params.id}/edit`, rows[0]), { active: 'knowledge_base' }));
});

app.post('/dashboard/knowledge_base/:id/edit', requireAuth, async (req, res) => {
  await pool.query('UPDATE knowledge_base SET question=$1, answer=$2, last_updated=now() WHERE id=$3', [req.body.question || null, req.body.answer || null, req.params.id]);
  res.redirect('/dashboard/knowledge_base');
});

app.post('/dashboard/knowledge_base/:id/delete', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM knowledge_base WHERE id = $1', [req.params.id]);
  res.redirect('/dashboard/knowledge_base');
});

// ---------- sops (CRUD + file upload) ----------

app.get('/dashboard/sops', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sops ORDER BY created_at DESC');
  const body = `<a class="btn-link" href="/dashboard/sops/new">+ Add SOP</a>
  <table><tr><th>Category</th><th>Title</th><th>Content</th><th>File</th><th>Created</th><th></th></tr>
  ${rows
    .map(
      (r) => `<tr><td>${esc(r.category)}</td><td>${esc(r.title)}</td><td>${esc((r.content || '').slice(0, 120))}${(r.content || '').length > 120 ? '…' : ''}</td>
      <td>${r.file_name ? `<a href="/dashboard/sops/${r.id}/file">${esc(r.file_name)}</a>` : '<span class="muted">none</span>'}</td>
      <td class="muted">${esc(fmtDate(r.created_at))}</td>
      <td class="row-actions"><a href="/dashboard/sops/${r.id}/edit">Edit</a>${deleteForm('sops', r.id)}</td></tr>`
    )
    .join('')}</table>`;
  res.send(layout('SOPs', body, { active: 'sops' }));
});

function sopForm(action, s = {}) {
  return `<div class="card" style="max-width:560px"><h2>${s.id ? 'Edit' : 'Add'} SOP</h2>
  <form method="post" action="${action}" enctype="multipart/form-data">
    <label>Category</label><input name="category" value="${esc(s.category)}">
    <label>Title</label><input name="title" value="${esc(s.title)}">
    <label>Content (optional if attaching a file)</label><textarea name="content" rows="6">${esc(s.content)}</textarea>
    <label>Attach file (PDF, doc, image - optional)</label><input type="file" name="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg">
    ${s.file_name ? `<div class="muted">Current file: ${esc(s.file_name)} (uploading a new one replaces it)</div>` : ''}
    <button type="submit">Save</button>
  </form></div>`;
}

app.get('/dashboard/sops/new', requireAuth, (req, res) => res.send(layout('Add SOP', sopForm('/dashboard/sops/new'), { active: 'sops' })));

function saveUploadedFile(file) {
  if (!file) return null;
  const finalName = `${crypto.randomUUID()}${path.extname(file.originalname)}`;
  const finalPath = path.join(UPLOAD_DIR, finalName);
  fs.renameSync(file.path, finalPath);
  return { file_name: file.originalname, file_path: finalPath, file_mime: file.mimetype };
}

app.post('/dashboard/sops/new', requireAuth, upload.single('file'), async (req, res) => {
  const f = saveUploadedFile(req.file);
  await pool.query(
    'INSERT INTO sops (category, title, content, file_name, file_path, file_mime) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.body.category || null, req.body.title || null, req.body.content || null, f?.file_name || null, f?.file_path || null, f?.file_mime || null]
  );
  res.redirect('/dashboard/sops');
});

app.get('/dashboard/sops/:id/edit', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sops WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).send(layout('Not found', 'SOP not found', { active: 'sops' }));
  res.send(layout('Edit SOP', sopForm(`/dashboard/sops/${req.params.id}/edit`, rows[0]), { active: 'sops' }));
});

app.post('/dashboard/sops/:id/edit', requireAuth, upload.single('file'), async (req, res) => {
  const f = saveUploadedFile(req.file);
  if (f) {
    const { rows } = await pool.query('SELECT file_path FROM sops WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE sops SET category=$1, title=$2, content=$3, file_name=$4, file_path=$5, file_mime=$6 WHERE id=$7', [
      req.body.category || null, req.body.title || null, req.body.content || null, f.file_name, f.file_path, f.file_mime, req.params.id,
    ]);
    if (rows[0]?.file_path && rows[0].file_path !== f.file_path) fs.unlink(rows[0].file_path, () => {});
  } else {
    await pool.query('UPDATE sops SET category=$1, title=$2, content=$3 WHERE id=$4', [req.body.category || null, req.body.title || null, req.body.content || null, req.params.id]);
  }
  res.redirect('/dashboard/sops');
});

app.post('/dashboard/sops/:id/delete', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT file_path FROM sops WHERE id = $1', [req.params.id]);
  await pool.query('DELETE FROM sops WHERE id = $1', [req.params.id]);
  if (rows[0]?.file_path) fs.unlink(rows[0].file_path, () => {});
  res.redirect('/dashboard/sops');
});

app.get('/dashboard/sops/:id/file', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT file_name, file_path, file_mime FROM sops WHERE id = $1', [req.params.id]);
  const s = rows[0];
  if (!s || !s.file_path || !fs.existsSync(s.file_path)) return res.status(404).send('No file attached');
  res.setHeader('Content-Type', s.file_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${s.file_name.replace(/"/g, '')}"`);
  fs.createReadStream(s.file_path).pipe(res);
});

// ---------- view-only tabs ----------

app.get('/dashboard/bookings', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT b.*, c.name AS client_name, c.phone_number AS client_phone
    FROM bookings b LEFT JOIN contacts c ON c.id = b.client_contact_id ORDER BY b.created_at DESC LIMIT 300`);
  const cols = ['event_name', 'event_date', 'event_type', 'status', 'mode', 'client_name', 'client_phone', 'created_at'];
  res.send(layout('Bookings', renderViewTable(cols, rows), { active: 'bookings' }));
});

app.get('/dashboard/conversations', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT cv.*, b.event_name, ct.name AS sender_name
    FROM conversations cv LEFT JOIN bookings b ON b.id = cv.booking_id LEFT JOIN contacts ct ON ct.id = cv.sender_contact_id
    ORDER BY cv.created_at DESC LIMIT 300`);
  const cols = ['event_name', 'sender_name', 'direction', 'message_text', 'stage', 'created_at'];
  res.send(layout('Conversations', renderViewTable(cols, rows), { active: 'conversations' }));
});

app.get('/dashboard/pending_questions', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT pq.*, b.event_name FROM pending_questions pq LEFT JOIN bookings b ON b.id = pq.booking_id ORDER BY pq.asked_at DESC NULLS LAST LIMIT 300`);
  const cols = ['event_name', 'field_name', 'question_text', 'asked_at', 'resolved_at'];
  res.send(layout('Pending Questions', renderViewTable(cols, rows), { active: 'pending_questions' }));
});

app.get('/dashboard/invoices', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT i.*, b.event_name FROM invoices i LEFT JOIN bookings b ON b.id = i.booking_id ORDER BY i.created_at DESC LIMIT 300`);
  const cols = ['event_name', 'invoice_number', 'bill_to_name', 'subtotal', 'vat_amount', 'wht_amount', 'total_net_payable', 'status', 'created_at'];
  const body = `<table><tr>${cols.map((c) => `<th>${esc(colLabel(c))}</th>`).join('')}<th></th></tr>
  ${rows
    .map(
      (r) => `<tr>${cols.map((c) => `<td>${esc(fmtCell(r[c]))}</td>`).join('')}
      <td class="row-actions">${r.invoice_number ? `<a href="${N8N_PUBLIC_URL}/webhook/invoice-pdf?invoice_number=${encodeURIComponent(r.invoice_number)}" target="_blank">View PDF</a>` : ''}</td></tr>`
    )
    .join('')}</table><p class="muted">Showing up to 300 most recent rows.</p>`;
  res.send(layout('Invoices', body, { active: 'invoices' }));
});

app.get('/dashboard/contracts', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT co.*, b.event_name FROM contracts co LEFT JOIN bookings b ON b.id = co.booking_id ORDER BY co.created_at DESC LIMIT 300`);
  const cols = ['event_name', 'organizer_legal_name', 'total_fee', 'payment_terms', 'signed_at', 'created_at'];
  res.send(layout('Contracts', renderViewTable(cols, rows), { active: 'contracts' }));
});

function colLabel(c) {
  return c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function renderViewTable(cols, rows) {
  return `<table><tr>${cols.map((c) => `<th>${esc(colLabel(c))}</th>`).join('')}</tr>
  ${rows
    .map((r) => `<tr>${cols.map((c) => `<td>${esc(fmtCell(r[c]))}</td>`).join('')}</tr>`)
    .join('')}</table><p class="muted">Showing up to 300 most recent rows.</p>`;
}

function fmtCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtDate(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toISOString().replace('T', ' ').slice(0, 16);
}

function deleteForm(table, id) {
  return `<form class="inline" method="post" action="/dashboard/${table}/${id}/delete" onsubmit="return confirm('Delete this row?');"><button class="danger" type="submit">Delete</button></form>`;
}

app.get('/', (req, res) => res.redirect('/dashboard/'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`bali-dashboard listening on ${PORT}`));
