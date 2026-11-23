// Bali dashboard (vanilla JS). Tabs: Reservations, Chats, Knowledge base, Settings.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const naira = (k) => '₦' + Math.round(Number(k) / 100).toLocaleString('en-US');
  const api = async (path, opts = {}) => {
    const r = await fetch('/api' + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (r.status === 401) { location.href = '/dashboard/login'; throw new Error('login'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.data = j; throw e; }
    return j;
  };
  let toastT;
  const toast = (msg, bad) => { let t = $('.toast'); if (!t) { t = h('div', { class: 'toast' }); document.body.append(t); } t.textContent = msg; t.className = 'toast on' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(() => (t.className = 'toast'), 2600); };

  const ICON = {
    res: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.5-4.6A8 8 0 1 1 21 12z"/></svg>',
    kb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16z"/><path d="M8 7h8M8 11h6"/></svg>',
    set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  };
  const TABS = [['res', 'Reservations'], ['chat', 'Chats'], ['kb', 'Knowledge base'], ['set', 'Settings']];
  let tab = (location.hash || '#res').slice(1); if (!TABS.some((t) => t[0] === tab)) tab = 'res';
  let charts = [], pollT = null;
  const killCharts = () => { charts.forEach((c) => c.destroy()); charts = []; clearInterval(pollT); };

  function shell() {
    const root = $('#root'); root.innerHTML = '';
    const nav = h('div', { class: 'nav' }, TABS.map(([k, label]) => h('button', { class: k === tab ? 'on' : '', html: ICON[k] + '<span>' + label + '</span>', onclick: () => go(k) })));
    root.append(
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, h('div', { class: 'logo' }), h('div', {}, h('b', {}, 'Bali'), h('span', {}, 'Reservations'))),
        nav, h('div', { class: 'grow' }), h('div', { class: 'who' }, 'Powered by ERA Systems'),
        h('form', { method: 'post', action: '/dashboard/logout' }, h('button', {}, 'Sign out'))),
      h('main', { class: 'main', id: 'main' }));
  }
  function go(k) { tab = k; location.hash = k; killCharts(); window.scrollTo(0, 0); render(); }
  function render() { shell(); ({ res: viewRes, chat: viewChat, kb: viewKb, set: viewSet })[tab](); }

  // ---------------- Reservations ----------------
  let days = 30, filter = { status: '', q: '' };
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const COL = { cream: '#e8c99b', creamD: 'rgba(232,201,155,.38)', teal: '#3aa3bd', ok: '#62c597', warn: '#e7b24a', bad: '#f0776a', mut: '#82705d' };
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif'; Chart.defaults.color = '#b4a089';
  const chartBase = () => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#2d1a0f', borderColor: 'rgba(232,201,155,.3)', borderWidth: 1, padding: 10, titleColor: '#f6ead9', bodyColor: '#e8c99b', displayColors: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#b4a089' }, border: { display: false } }, y: { beginAtZero: true, grid: { color: 'rgba(232,201,155,.08)' }, ticks: { color: '#82705d', precision: 0 }, border: { display: false } } } });
  const fmtHour = (n) => { const s = n >= 12 ? 'pm' : 'am'; return (n % 12 || 12) + s; };
  const dayLabel = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return WD[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }); };

  async function viewRes() {
    const main = $('#main');
    main.append(
      h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Reservations'), h('p', {}, 'Tables booked, who is coming and how the venue is filling up.')),
        h('div', { class: 'seg' }, [[7, '7d'], [30, '30d'], [90, '90d'], [365, '1y']].map(([d, l]) => h('button', { class: d === days ? 'on' : '', onclick: () => { days = d; go('res'); } }, l)))),
      h('div', { id: 'kp', class: 'grid g4' }), h('div', { id: 'ch', style: 'margin-top:16px' }),
      h('div', { class: 'card', style: 'margin-top:16px' }, h('h3', {}, 'All reservations'), h('div', { class: 'sub' }, 'Click a row for details and actions.'),
        h('div', { class: 'tools' },
          h('input', { class: 'search', placeholder: 'Search name, phone or reference', value: filter.q, oninput: (e) => { filter.q = e.target.value; clearTimeout(viewRes.t); viewRes.t = setTimeout(loadRows, 250); } }),
          h('div', { class: 'seg' }, [['', 'All'], ['confirmed', 'Confirmed'], ['pending_payment', 'Pending'], ['cancelled', 'Cancelled']].map(([v, l]) => h('button', { class: filter.status === v ? 'on' : '', onclick: (e) => { filter.status = v; [...e.target.parentNode.children].forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); loadRows(); } }, l)))),
        h('div', { class: 'tblwrap', id: 'tbl' })));
    const o = await api('/overview?days=' + days);
    const k = o.kpis;
    $('#kp').append(
      kpi('Tables today', k.todayTables, k.todayGuests + ' guests expected', true),
      kpi('Upcoming', k.upcoming, k.upcomingGuests + ' guests booked ahead'),
      kpi('Revenue (' + days + 'd)', naira(k.revenueKobo), naira(k.refundedKobo) + ' refunded'),
      kpi('Cancellations', Math.round(k.cancelRate * 100) + '%', 'Avg party ' + k.avgParty.toFixed(1)));
    const ch = $('#ch');
    ch.append(
      h('div', { class: 'grid g2' }, card('Most booked days', 'Bookings by day of the week, last ' + days + ' days', 'c1'), card('Next 30 days', 'Guests booked per day', 'c2')),
      h('div', { class: 'grid g3', style: 'margin-top:16px' }, card('Arrival times', 'When guests arrive', 'c3'), card('Booking status', 'Everything created in the period', 'c4', 'sm'), top5(o.topDays)));
    // weekday (Mon..Sun order), highlight the busiest
    const order = [1, 2, 3, 4, 5, 6, 0]; const wd = order.map((d) => (o.byWeekday.find((x) => x.dow === d) || { bookings: 0 }).bookings);
    const mx = Math.max(...wd, 0);
    chartOrEmpty('c1', mx, () => ({ type: 'bar', data: { labels: order.map((d) => WD[d]), datasets: [{ data: wd, borderRadius: 8, backgroundColor: wd.map((v) => (v === mx ? COL.cream : COL.creamD)), maxBarThickness: 44 }] }, options: { ...chartBase(), plugins: { ...chartBase().plugins, tooltip: { ...chartBase().plugins.tooltip, callbacks: { label: (c) => c.parsed.y + ' bookings' } } } } }));
    const up = o.upcomingDaily; const dayMap = Object.fromEntries(up.map((u) => [u.day, u.guests]));
    const lab = [], vals = []; for (let i = 0; i < 30; i++) { const d = new Date(o.today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); const iso = d.toISOString().slice(0, 10); lab.push(iso); vals.push(dayMap[iso] || 0); }
    chartOrEmpty('c2', Math.max(...vals, 0), () => ({ type: 'bar', data: { labels: lab.map((l) => dayLabel(l).slice(4)), datasets: [{ data: vals, borderRadius: 5, backgroundColor: COL.teal, maxBarThickness: 18 }] }, options: { ...chartBase(), scales: { ...chartBase().scales, x: { ...chartBase().scales.x, ticks: { color: '#82705d', maxTicksLimit: 8, maxRotation: 0 } } }, plugins: { ...chartBase().plugins, tooltip: { ...chartBase().plugins.tooltip, callbacks: { title: (i) => dayLabel(lab[i[0].dataIndex]), label: (c) => c.parsed.y + ' guests' } } } } }));
    const hrs = o.byHour;
    chartOrEmpty('c3', hrs.length, () => ({ type: 'bar', data: { labels: hrs.map((x) => fmtHour(x.hour)), datasets: [{ data: hrs.map((x) => x.bookings), borderRadius: 8, backgroundColor: COL.cream, maxBarThickness: 40 }] }, options: { ...chartBase(), plugins: { ...chartBase().plugins, tooltip: { ...chartBase().plugins.tooltip, callbacks: { label: (c) => c.parsed.y + ' bookings' } } } } }));
    const stCol = { confirmed: COL.ok, pending_payment: COL.warn, cancelled: COL.bad, expired: COL.mut, completed: COL.teal, no_show: '#b4a089' };
    chartOrEmpty('c4', o.status.length, () => ({ type: 'doughnut', data: { labels: o.status.map((s) => s.status.replace('_', ' ')), datasets: [{ data: o.status.map((s) => s.n), backgroundColor: o.status.map((s) => stCol[s.status] || COL.mut), borderWidth: 0, spacing: 3 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: true, position: 'right', labels: { color: '#e8d7bf', boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 12 } }, tooltip: chartBase().plugins.tooltip } } }));
    loadRows();
  }
  const kpi = (l, v, d, accent) => h('div', { class: 'card kpi' + (accent ? ' accent' : '') }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, String(v)), h('div', { class: 'd' }, d));
  const card = (t, s, id, sm) => h('div', { class: 'card' }, h('h3', {}, t), h('div', { class: 'sub' }, s), h('div', { class: 'chart' + (sm ? ' sm' : ''), id: id + 'w' }, h('canvas', { id })));
  function chartOrEmpty(id, hasData, mk) {
    if (!hasData) { $('#' + id + 'w').innerHTML = '<div class="empty">No data in this period yet.</div>'; return; }
    charts.push(new Chart($('#' + id), mk()));
  }
  const top5 = (rows) => h('div', { class: 'card top5' }, h('h3', {}, 'Busiest dates'), h('div', { class: 'sub' }, 'Most guests in the period'),
    rows.length ? rows.map((r, i) => h('div', { class: 'it' }, h('div', { class: 'rk' }, String(i + 1)), h('div', { class: 'm' }, h('b', {}, dayLabel(r.day)), h('span', {}, r.bookings + ' bookings')), h('div', { class: 'g' }, r.guests + ' guests'))) : h('div', { class: 'empty' }, 'No bookings yet.'));

  async function loadRows() {
    const p = new URLSearchParams(); if (filter.status) p.set('status', filter.status); if (filter.q) p.set('q', filter.q);
    const { rows } = await api('/reservations?' + p);
    const box = $('#tbl'); if (!box) return;
    if (!rows.length) { box.innerHTML = '<div class="empty">No reservations match.</div>'; return; }
    box.innerHTML = '';
    box.append(h('table', {}, h('thead', {}, h('tr', {}, ['Guest', 'Date', 'Arrival', 'Guests', 'Status', 'Paid', 'Ref'].map((c) => h('th', {}, c)))),
      h('tbody', {}, rows.map((r) => h('tr', { onclick: () => drawer(r) },
        h('td', { class: 'nm' }, h('b', {}, r.guest_name || 'Guest'), h('span', {}, '+' + String(r.contact_phone || r.phone_number).replace(/^\+/, ''))),
        h('td', {}, r.date_label), h('td', {}, r.time_label), h('td', {}, String(r.guests)),
        h('td', {}, h('span', { class: 'st ' + r.status }, r.status.replace('_', ' '))),
        h('td', {}, r.paid_amount_kobo ? naira(r.paid_amount_kobo) : '—'), h('td', {}, r.ref))))));
  }
  function drawer(r) {
    $('.veil')?.remove(); $('.drawer')?.remove();
    const veil = h('div', { class: 'veil', onclick: close }); const dr = h('div', { class: 'drawer' });
    function close() { veil.classList.remove('on'); dr.classList.remove('on'); setTimeout(() => { veil.remove(); dr.remove(); }, 250); }
    const active = r.status === 'confirmed' || r.status === 'pending_payment';
    let mode = 'auto';
    dr.append(h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start' }, h('div', {}, h('h2', {}, r.guest_name || 'Guest'), h('span', { class: 'st ' + r.status }, r.status.replace('_', ' '))), h('button', { class: 'btn', onclick: close }, 'Close')),
      h('dl', { class: 'kv' }, ...[['Reference', r.ref], ['Date', r.date_label], ['Arrival', r.time_label], ['Guests', r.guests], ['Phone', '+' + String(r.contact_phone || r.phone_number).replace(/^\+/, '')], ['WhatsApp', '+' + r.phone_number], ['Paid', r.paid_amount_kobo ? naira(r.paid_amount_kobo) : 'No payment'], ['Refunded', r.refund_amount_kobo ? naira(r.refund_amount_kobo) : '—'], ['Handed over', r.handed_over_at ? new Date(r.handed_over_at).toLocaleString() : 'No'], ['Reminder', r.reminder_sent_at ? 'Sent ' + new Date(r.reminder_sent_at).toLocaleString() : 'Not sent yet'], ['Created', new Date(r.created_at).toLocaleString()]].flatMap(([a, b]) => [h('dt', {}, a), h('dd', {}, String(b))])));
    if (active) {
      const opts = [['auto', 'Follow the policy', 'Refunds the reservation fee only if it is far enough ahead.'], ['full', 'Refund everything', 'Returns the full amount paid, including the service fee.'], ['none', 'No refund', 'Keeps the payment.']];
      dr.append(h('h3', { style: 'margin:20px 0 4px' }, 'Cancel this reservation'),
        ...(r.paid_amount_kobo ? opts.map(([v, t, s]) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'rf', checked: v === 'auto', onchange: () => (mode = v) }), h('div', {}, h('b', {}, t), h('span', {}, s)))) : []),
        h('div', { class: 'row', style: 'margin-top:14px' },
          h('button', { class: 'btn danger', onclick: async (e) => { if (!confirm('Cancel ' + r.ref + ' and tell the guest on WhatsApp?')) return; e.target.disabled = true; try { await api('/reservations/' + r.ref + '/cancel', { method: 'POST', body: { refund: mode } }); toast('Cancelled and the guest was told'); close(); loadRows(); } catch (er) { toast(er.message, true); e.target.disabled = false; } } }, 'Cancel reservation'),
          r.status === 'confirmed' ? h('button', { class: 'btn', onclick: async () => { await api('/reservations/' + r.ref + '/status', { method: 'POST', body: { status: 'completed' } }); toast('Marked completed'); close(); loadRows(); } }, 'Mark completed') : null,
          r.status === 'confirmed' ? h('button', { class: 'btn', onclick: async () => { await api('/reservations/' + r.ref + '/status', { method: 'POST', body: { status: 'no_show' } }); toast('Marked no show'); close(); loadRows(); } }, 'No show') : null));
    }
    document.body.append(veil, dr); requestAnimationFrame(() => { veil.classList.add('on'); dr.classList.add('on'); });
  }

  // ---------------- Chats ----------------
  let activeChat = null;
  async function viewChat() {
    const main = $('#main');
    main.append(h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Chats'), h('p', {}, 'Every guest conversation: the WhatsApp card and the enquiry chat.'))));
    const wrap = h('div', { class: 'chats' + (activeChat ? ' open' : '') });
    const list = h('div', { class: 'tl' }); const search = h('input', { class: 'search', placeholder: 'Search by name or number', style: 'width:100%' });
    const convo = h('div', { class: 'convo' });
    wrap.append(h('div', { class: 'threads' }, h('div', { class: 's' }, search), list), convo); main.append(wrap);
    let all = [];
    const ago = (t) => { const m = Math.floor((Date.now() - new Date(t)) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h' : Math.floor(m / 1440) + 'd'; };
    function drawList() {
      const q = search.value.toLowerCase(); list.innerHTML = '';
      const rows = all.filter((r) => !q || r.phone_number.includes(q) || (r.name || '').toLowerCase().includes(q));
      if (!rows.length) list.append(h('div', { class: 'empty' }, 'No conversations yet.'));
      rows.forEach((r) => list.append(h('div', { class: 'th' + (r.phone_number === activeChat ? ' on' : ''), onclick: () => { activeChat = r.phone_number; wrap.classList.add('open'); drawList(); loadConvo(); } },
        h('div', { class: 'av' }, (r.name || r.phone_number).slice(0, 1).toUpperCase()), h('div', { class: 't' }, h('b', {}, r.name || '+' + r.phone_number, h('i', {}, ago(r.last_at))), h('span', {}, (r.last_dir === 'outbound' ? 'Bot: ' : '') + (r.last_body || ''))))));
    }
    async function loadList() { all = (await api('/chats')).rows; drawList(); }
    async function loadConvo() {
      if (!activeChat) { convo.innerHTML = '<div class="empty" style="margin:auto">Select a conversation</div>'; return; }
      const d = await api('/chats/' + activeChat); const r = all.find((x) => x.phone_number === activeChat) || {};
      convo.innerHTML = '';
      const back = h('button', { class: 'btn', style: 'display:none', onclick: () => { activeChat = null; wrap.classList.remove('open'); loadConvo(); drawList(); } }, '‹ Back');
      if (matchMedia('(max-width:980px)').matches) back.style.display = 'inline-block';
      convo.append(h('div', { class: 'ch' }, back, h('div', { class: 'av' }, (r.name || activeChat).slice(0, 1).toUpperCase()), h('div', {}, h('b', {}, r.name || '+' + activeChat), h('span', {}, '+' + activeChat + (d.reservations[0] ? ' · last booking ' + d.reservations[0].ref + ' (' + d.reservations[0].status.replace('_', ' ') + ')' : '')))));
      const box = h('div', { class: 'msgs' }); let lastDay = '';
      d.messages.forEach((m) => { const t = new Date(m.created_at); const day = t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); if (day !== lastDay) { box.append(h('div', { class: 'dayd' }, day)); lastDay = day; }
        box.append(h('div', { class: 'bub ' + (m.direction === 'inbound' ? 'in' : 'out') }, m.body, m.interactive && m.interactive.url ? h('div', { style: 'margin-top:6px;color:var(--cream);font-weight:600' }, '[' + m.interactive.label + ']') : null, h('small', {}, h('span', { class: 'tag ' + (m.channel === 'web' ? 'web' : 'wa') }, m.channel === 'web' ? 'ENQUIRY CHAT' : 'WHATSAPP'), t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))); });
      convo.append(box); box.scrollTop = box.scrollHeight;
    }
    search.oninput = drawList; await loadList(); await loadConvo();
    pollT = setInterval(async () => { try { await loadList(); if (activeChat) await loadConvo(); } catch (e) {} }, 8000);
  }

  // ---------------- Knowledge base ----------------
  async function viewKb() {
    const main = $('#main');
    main.append(h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Knowledge base'), h('p', {}, 'The bot answers every enquiry from here. Add a question and its answer and it is live straight away.'))));
    const holder = h('div', {}); main.append(holder);
    async function load() {
      const d = await api('/kb'); holder.innerHTML = '';
      const q = h('input', { class: 'fi', placeholder: 'Question, e.g. Do you have parking?' }); const a = h('textarea', { class: 'fi', rows: 3, placeholder: 'Answer the bot should give' }); const kw = h('input', { class: 'fi', placeholder: 'Other words guests might use (optional), e.g. park car valet' });
      holder.append(h('div', { class: 'card kbc' }, h('h3', {}, 'Add a question'), h('div', { class: 'sub' }, 'Keep answers short and friendly.'), q, a, kw,
        h('button', { class: 'btn primary', onclick: async () => { try { await api('/kb', { method: 'POST', body: { question: q.value, answer: a.value, keywords: kw.value } }); toast('Added'); load(); } catch (e) { toast(e.message, true); } } }, 'Add to knowledge base')));
      if (d.unanswered.length) holder.append(h('div', { class: 'card kbc un' }, h('h3', {}, 'Questions the bot could not answer'), h('div', { class: 'sub' }, 'Guests asked these. Write an answer and the bot will know it next time.'),
        d.unanswered.map((u) => { const ans = h('textarea', { class: 'fi', rows: 2, placeholder: 'Your answer' }); return h('div', { style: 'border-top:1px solid var(--line);padding-top:12px;margin-top:12px' }, h('div', { class: 'q' }, u.question), h('div', { class: 'kw', style: 'margin:4px 0 8px' }, '+' + u.phone_number + ' · ' + new Date(u.created_at).toLocaleString()), ans,
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { await api('/kb/unanswered/' + u.id + '/answer', { method: 'POST', body: { question: u.question, answer: ans.value } }); toast('Saved to the knowledge base'); load(); } catch (e) { toast(e.message, true); } } }, 'Save answer'), h('button', { class: 'btn', onclick: async () => { await api('/kb/unanswered/' + u.id, { method: 'DELETE' }); load(); } }, 'Dismiss'))); })));
      holder.append(h('div', { class: 'head', style: 'margin:22px 0 12px' }, h('h3', { style: 'margin:0;font-size:17px' }, d.rows.length + ' answers')));
      d.rows.forEach((r) => holder.append(kbCard(r, load)));
      if (!d.rows.length) holder.append(h('div', { class: 'empty' }, 'Nothing here yet. Add the first question above.'));
    }
    function kbCard(r, reload) {
      const box = h('div', { class: 'card kbc' });
      const view = () => { box.innerHTML = ''; box.append(h('div', { class: 'q' }, r.question), h('div', { class: 'a' }, r.answer), r.keywords ? h('div', { class: 'kw' }, 'Also matches: ' + r.keywords) : null,
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: edit }, 'Edit'), h('button', { class: 'btn danger', onclick: async () => { if (!confirm('Delete this answer?')) return; await api('/kb/' + r.id, { method: 'DELETE' }); toast('Deleted'); reload(); } }, 'Delete'))); };
      const edit = () => { const q = h('input', { value: r.question }); const a = h('textarea', { rows: 4 }, r.answer); const k = h('input', { value: r.keywords || '', placeholder: 'Other words guests might use' }); box.innerHTML = ''; box.append(q, a, k, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { Object.assign(r, await api('/kb/' + r.id, { method: 'PUT', body: { question: q.value, answer: a.value, keywords: k.value } })); toast('Saved'); view(); } catch (e) { toast(e.message, true); } } }, 'Save'), h('button', { class: 'btn', onclick: view }, 'Cancel'))); };
      view(); return box;
    }
    await load();
  }

  // ---------------- Settings ----------------
  async function viewSet() {
    const main = $('#main');
    main.append(h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Settings'), h('p', {}, 'Handover number, payments, opening hours and capacity.'))));
    const { settings: S, paystackConfigured, whatsappConfigured } = await api('/settings');
    const F = {}; const errBox = {};
    const field = (key, label, type, hint, opts = {}) => {
      const val = opts.fromNaira ? S[key] / 100 : (S[key] ?? '');
      const input = opts.area ? h('textarea', { class: 'fi', rows: 3 }, val) : h('input', { class: 'fi', type: type || 'text', value: val, style: 'margin:0' });
      F[key] = () => { const v = input.value; if (opts.fromNaira) return Math.round(Number(v) * 100); return type === 'number' ? Number(v) : v; };
      const er = h('div', { class: 'er' }); errBox[key] = er;
      return h('div', { class: 'fld' }, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null, er);
    };
    const dayChecks = h('div', { class: 'days' }, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => h('label', {}, h('input', { type: 'checkbox', value: i, checked: (S.closed_weekdays || []).includes(i) }), d)));
    F.closed_weekdays = () => [...dayChecks.querySelectorAll('input:checked')].map((x) => Number(x.value));
    const pay = h('input', { type: 'checkbox', checked: !!S.payments_enabled }); F.payments_enabled = () => pay.checked;
    const open24 = h('input', { type: 'checkbox', checked: !!S.open_24_7 }); F.open_24_7 = () => open24.checked;
    const notifyCh = h('input', { type: 'checkbox', checked: S.notify_changes !== false }); F.notify_changes = () => notifyCh.checked;
    main.append(
      !whatsappConfigured ? h('div', { class: 'warn' }, 'WhatsApp is not connected on this server yet, so messages are only recorded, not sent.') : null,
      h('div', { class: 'card sec' }, h('h3', {}, 'Handover'), h('div', { class: 'sub' }, 'Every completed reservation is sent to these WhatsApp numbers with the guest\'s name, phone, date, arrival time and guests.'),
        h('div', { class: 'fg' }, field('handover_number', 'Handover WhatsApp number', 'tel', 'e.g. 0803 000 0000 or +234 803 000 0000'), field('handover_number_2', 'Second handover number (optional)', 'tel', 'Gets exactly the same messages')),
        h('div', { class: 'sw', style: 'margin-top:14px' }, notifyCh, h('div', {}, h('b', {}, 'Also tell this number when a guest changes or cancels'))),
        h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: async (e) => { e.target.disabled = true; try { await save(true); const r = await api('/settings/test-handover', { method: 'POST' }); toast(r.ok ? 'Test message sent' : r.note, !r.ok); if (r.ok) alert(r.note); } catch (er) { toast(er.message, true); } e.target.disabled = false; } }, 'Save and send a test message'))),
      h('div', { class: 'card sec' }, h('h3', {}, 'Payment'), h('div', { class: 'sub' }, paystackConfigured ? 'Paystack is connected.' : 'Paystack is not connected yet. Add the secret key on the server before taking payments.'),
        !paystackConfigured && S.payments_enabled ? h('div', { class: 'warn' }, 'Payments are on but Paystack is not connected, so the form will show "payment not available". Switch payments off below to take free reservations for now.') : null,
        h('div', { class: 'sw', style: 'margin-bottom:16px' }, pay, h('div', {}, h('b', {}, 'Take payment to confirm a reservation'))),
        h('div', { class: 'fg' }, field('reservation_fee_kobo', 'Reservation amount (₦)', 'number', 'Credited to the guest\'s order', { fromNaira: true }), field('service_fee_kobo', 'Service fee (₦)', 'number', 'Not refundable', { fromNaira: true }), field('refund_hours', 'Refund if cancelled at least (hours) before', 'number'), field('order_link', 'Order link', 'text', 'Sent to guests after they pay'))),
      h('div', { class: 'card sec' }, h('h3', {}, 'Opening hours and capacity'), h('div', { class: 'sub' }, 'Guests type the time they want to arrive. Turn off "open 24 hours" to only accept times within set hours.'),
        h('div', { class: 'sw', style: 'margin-bottom:16px' }, open24, h('div', {}, h('b', {}, 'Open 24 hours'))),
        h('div', { class: 'fg' }, field('reminder_hours', 'Send a reminder before arrival (hours, 0 = off)', 'number', 'Guests get the booking details and a CHAT WITH US button'), field('change_cutoff_hours', 'Guests can change a reservation until (hours before arrival, 0 = any time)', 'number', 'They change the date, time or guests from their reservation page'), field('open_time', 'Opening time', 'time', 'Only used when Open 24 hours is off'), field('close_time', 'Closing time', 'time', 'Last arrival is one slot before closing'), field('slot_minutes', 'Slot length (minutes)', 'number'), field('max_days_ahead', 'Book up to (days ahead)', 'number')),
        h('div', { class: 'fld', style: 'margin-top:16px' }, h('label', {}, 'Closed on'), dayChecks)),
      h('div', { class: 'card sec' }, h('h3', {}, 'Welcome message'), h('div', { class: 'sub' }, 'The first WhatsApp message a guest receives, with the Bali picture and the reservation button.'),
        h('div', { class: 'fg', style: 'grid-template-columns:1fr' }, field('welcome_text', 'Welcome text', 'text', null, { area: true }), field('enquiry_intro', 'Enquiry chat greeting', 'text'))),
      h('button', { class: 'btn primary', onclick: () => save(false) }, 'Save settings'));
    async function save(quiet) {
      Object.values(errBox).forEach((e) => (e.textContent = ''));
      const body = {}; for (const [k, fn] of Object.entries(F)) body[k] = fn();
      try { await api('/settings', { method: 'PUT', body }); if (!quiet) toast('Settings saved'); } catch (e) { Object.entries(e.data?.errors || {}).forEach(([k, m]) => { if (errBox[k]) errBox[k].textContent = m; }); toast('Please fix the highlighted fields', true); throw e; }
    }
  }

  render();
})();
