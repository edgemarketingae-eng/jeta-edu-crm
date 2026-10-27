/* Jeta Edu CRM – single-page client (no build step). */
(() => {
  'use strict';

  // ---------------- core ----------------
  const S = { token: localStorage.getItem('jeta_token'), me: null, perms: [], meta: null, counts: {} };
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const can = (p) => S.perms.includes(p);
  const role = () => S.me?.role;

  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !path.startsWith('/login')) { logout(); throw new Error('Please sign in again'); }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (res.status === 403 && data.code === '2FA_SETUP') { render2faSetup(); throw new Error(data.error); }
    if (!res.ok) throw Object.assign(new Error(data.error || data || `Request failed (${res.status})`), { data, status: res.status });
    return data;
  }
  const get = (p) => api('GET', p);
  const post = (p, b) => api('POST', p, b || {});

  async function openDoc(path, filename) {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${S.token}` } });
    if (!res.ok) return toast('Could not open document', true);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (filename) { const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); }
    else window.open(url, '_blank');
  }

  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg; t.className = `show${bad ? ' bad' : ''}`;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 3200);
  }

  // ---------------- formatting ----------------
  const dt = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const d = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
  const money = (n, c) => `${c || ''} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`.trim();
  const ago = (iso) => {
    if (!iso) return '—';
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (Math.abs(m) < 60) return m >= 0 ? `${m}m ago` : `in ${-m}m`;
    const h = Math.round(m / 60);
    if (Math.abs(h) < 48) return h >= 0 ? `${h}h ago` : `in ${-h}h`;
    const dd = Math.round(h / 24);
    return dd >= 0 ? `${dd}d ago` : `in ${-dd}d`;
  };
  function dueCell(iso) {
    if (!iso) return '<span class="muted">No follow-up</span>';
    const t = new Date(iso); const nowD = new Date();
    const cls = t < nowD ? 'due-over' : t.toDateString() === nowD.toDateString() ? 'due-today' : '';
    return `<span class="${cls}">${dt(iso)}</span> <span class="muted small">${ago(iso)}</span>`;
  }
  const toIso = (v) => (v ? new Date(v).toISOString() : undefined);
  const localInput = (iso) => { if (!iso) return ''; const x = new Date(iso); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  const inHours = (h) => localInput(new Date(Date.now() + h * 3600000).toISOString());

  const STAGE_PILL = {
    New: 'blue', Attempted: 'amber', Contacted: 'green', Qualified: 'green', 'Demo Scheduled': 'blue', 'Demo Done': 'blue',
    Negotiation: 'amber', 'Payment Pending': 'amber', Converted: 'green', Lost: 'red', Nurture: '',
    'Awaiting Teacher': 'amber', 'Teacher Assigned': 'blue', Scheduled: 'blue', Active: 'green', 'Hours Low': 'red',
    Completed: '', Renewed: 'green', Churned: 'red', Paused: '',
    Paid: 'green', Partial: 'amber', Pending: 'amber', Refunded: '', 'Refund Requested': 'red', 'Refund Approved': 'red',
    Approved: 'blue', Open: 'amber', Done: 'green', 'Renewal Discussion': 'amber',
    Hot: 'red', Warm: 'amber', 'On time': 'green', Late: 'red', Due: 'amber', Held: 'green', Resolved: 'green', Rejected: 'red', Overdue: 'red', Inactive: '', Unmarked: 'red', Demo: 'blue', High: 'red', Cold: 'blue', Submitted: 'blue', Verified: 'green', Rejected: 'red',
    'Student Absent (no notice)': 'red', 'Student Absent (notice given)': 'amber', 'Teacher Absent': 'red', Cancelled: '', Rescheduled: 'blue',
  };
  const pill = (s) => (s ? `<span class="pill ${STAGE_PILL[s] || ''}">${esc(s)}</span>` : '');
  const opts = (arr, sel, blank) => (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') +
    arr.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
  const users = (filter) => S.meta.users.filter((u) => u.active && (!filter || filter(u)));
  const salesUsers = () => users((u) => ['sales_exec', 'sales_manager'].includes(u.role)).map((u) => [u.id, u.name]);
  function hoursClass(s) {
    const left = s.total_hours - s.hours_used;
    if (!s.total_hours) return '';
    if (left <= 2 || left / s.total_hours <= 0.10) return 'urgent';
    if (left / s.total_hours <= 0.25) return 'low';
    return '';
  }

  // ---------------- modal + forms ----------------
  function formData(form) {
    const o = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'checkbox') {
        if (el.dataset.multi) { (o[el.name] ||= []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked ? 1 : 0;
      } else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; } else if (el.type === 'datetime-local') o[el.name] = toIso(el.value);
      else o[el.name] = el.value === '' ? undefined : el.value;
    }
    return o;
  }

  function modal({ title, body, submit = 'Save', wide = false, onSubmit, onOpen }) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="overlay"><form class="modal ${wide ? 'wide' : ''}" novalidate>
      <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="link" data-close aria-label="Close">Close</button></div>
      <div class="modal-body">${body}</div><div class="err" hidden></div>
      ${onSubmit ? `<div class="modal-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">${esc(submit)}</button></div>` : ''}
    </form></div>`;
    const form = $('form', root);
    const close = () => { root.innerHTML = ''; };
    $$('[data-close]', root).forEach((b) => b.addEventListener('click', close));
    $('.overlay', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('overlay')) close(); });
    document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('.err', form); errEl.hidden = true;
      const btn = $('button[type=submit]', form); btn.disabled = true;
      try { await onSubmit(formData(form), form); close(); } catch (err) { errEl.textContent = err.message; errEl.hidden = false; } finally { btn.disabled = false; }
    });
    mobilize(form);
    onOpen?.(form);
    // On phones, don't pop the keyboard over the sheet before the user chooses a field.
    if (!window.matchMedia('(max-width: 720px)').matches) $('input,select,textarea', form)?.focus();
    return form;
  }
  const field = (label, html, cls = '') => `<div class="field ${cls}"><label>${esc(label)}</label>${html}</div>`;
  const input = (name, val = '', type = 'text', extra = '') => `<input name="${name}" type="${type}" value="${esc(val)}" ${extra}>`;
  const select = (name, arr, sel, blank, extra = '') => `<select name="${name}" ${extra}>${opts(arr, sel, blank)}</select>`;
  const followUpFields = (at = inHours(2), type = 'call') => `<div class="grid2">
    ${field('Next follow-up', `<input name="follow_up_at" type="datetime-local" value="${esc(at)}">`)}
    ${field('Follow-up type', select('follow_up_type', [['call', 'Call'], ['whatsapp', 'WhatsApp'], ['demo', 'Demo'], ['payment', 'Payment']], type))}</div>`;

  // ---------------- auth ----------------
  function logout() { post('/logout').catch(() => {}); S.token = null; localStorage.removeItem('jeta_token'); renderLogin(); }

  function renderLogin() {
    $('#app').innerHTML = `<div class="login">
      <div class="art"><div class="brand"><span class="mark">J</span> Jeta Edu</div>
        <div><h1>Every lead followed up. Every hour accounted for.</h1>
        <p>Sales, academics, retention, accounts and teacher payouts in one record – from the first Instagram DM to the renewal.</p></div>
        <div class="flow">Lead → Contacted → Qualified → Demo → Converted → Teacher assigned → Active → Renewed</div></div>
      <form id="login-form"><h2>Sign in</h2>
        ${field('Email', input('email', '', 'email', 'autocomplete="username" required'))}
        ${field('Password', input('password', '', 'password', 'autocomplete="current-password" required'))}
        <button class="primary" style="width:100%">Sign in</button><div class="err" hidden></div>
        <p class="muted small" id="demo-hint" hidden style="margin-top:18px">Demo: owner@jeta.edu, manager@, aisha@, admin@, accounts@ – password jeta1234</p></form></div>`;
    fetch('/api/app-info').then((r) => r.json()).then((i) => { const h = $('#demo-hint'); if (h && i.demo) h.hidden = false; }).catch(() => {});
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try {
        const r = await post('/login', f);
        if (r.twofa) return render2faCode(r.ticket);
        S.token = r.token; localStorage.setItem('jeta_token', r.token);
        await boot();
      } catch (err) { const el = $('.err', e.target); el.textContent = err.message; el.hidden = false; }
    });
  }

  // Second step: 6-digit code from the authenticator app.
  function render2faCode(ticket) {
    const old = $('#login-form');
    const form = old.cloneNode(false); // drops the password-step listener
    old.replaceWith(form);
    form.innerHTML = `<h2>Two-step sign-in</h2><p class="muted">Enter the 6-digit code from your authenticator app.</p>
      ${field('Code', input('code', '', 'text', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus'))}
      <button class="primary" style="width:100%">Verify</button><div class="err" hidden></div>
      <p class="small" style="margin-top:14px"><button type="button" class="link" id="back-login">Use a different account</button></p>`;
    $('#back-login').onclick = renderLogin;
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await post('/login/2fa', { ticket, code: form.code.value });
        S.token = r.token; localStorage.setItem('jeta_token', r.token);
        await boot();
      } catch (err) { const el = $('.err', form); el.textContent = err.message; el.hidden = false; }
    };
  }

  // Owner, Admin and Accounts must turn on two-factor sign-in before using the CRM (production).
  async function render2faSetup() {
    if (document.body.dataset.setup2fa) return;
    document.body.dataset.setup2fa = '1';
    const r = await fetch('/api/2fa/setup', { method: 'POST', headers: { Authorization: `Bearer ${S.token}` } }).then((x) => x.json());
    $('#app').innerHTML = `<div class="login"><div class="art"><div class="brand"><span class="mark">J</span> Jeta Edu</div>
      <div><h1>Protect your account</h1><p>Your role can see payments, payouts or KYC, so sign-in needs a code from your phone as well as your password.</p></div><div></div></div>
      <form id="setup-form"><h2>Set up two-step sign-in</h2>
        <ol class="small" style="padding-left:18px;line-height:1.7"><li>Install Google Authenticator or Microsoft Authenticator.</li><li>Scan this code, or enter the key manually.</li><li>Type the 6-digit code it shows.</li></ol>
        <div id="qr" style="background:#fff;padding:10px;display:inline-block;border:1px solid var(--line);border-radius:8px;margin:6px 0"></div>
        <p class="small muted">Key: <code style="word-break:break-all">${esc(r.secret || '')}</code></p>
        ${field('Code from the app', input('code', '', 'text', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" required'))}
        <button class="primary" style="width:100%">Turn on and continue</button><div class="err" hidden></div>
        <p class="small" style="margin-top:14px"><button type="button" class="link" id="setup-out">Sign out</button></p></form></div>`;
    $('#setup-out').onclick = () => { delete document.body.dataset.setup2fa; logout(); };
    const s1 = document.createElement('script');
    s1.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s1.onload = () => { try { new window.QRCode($('#qr'), { text: r.otpauth, width: 180, height: 180 }); } catch { /* manual key still works */ } };
    document.head.appendChild(s1);
    $('#setup-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await post('/2fa/enable', { code: e.target.code.value });
        delete document.body.dataset.setup2fa;
        toast('Two-step sign-in is on');
        await boot();
      } catch (err) { const el = $('.err', e.target); el.textContent = err.message; el.hidden = false; }
    };
  }

  async function boot() {
    if (!S.token) return renderLogin();
    try {
      const me = await get('/me');
      S.me = me.user; S.perms = me.perms;
      if (me.needs2faSetup) return render2faSetup();
      S.meta = await get('/meta');
      S.settings = await get('/settings').catch(() => ({}));
      if (!location.hash) location.hash = '#/dashboard';
      route();
    } catch { renderLogin(); }
  }

  // ---------------- layout ----------------
  const NAV = [
    ['Sales', [['#/dashboard', 'Dashboard'], ['#/leads', 'Leads', 'overdue'], ['#/pipeline', 'Pipeline'], ['#/leaderboard', 'Leaderboard', null, 'game.view'], ['#/tasks', 'My tasks'], ['#/scorecard', 'My scorecard'], ['#/phone', 'Phone tracker', null, 'game.view']]],
    ['Academics', [['#/students', 'Students'], ['#/classes', 'Classes & attendance', null, 'students.view'], ['#/teachers', 'Teachers', null, 'teachers.view']]],
    ['Finance', [['#/accounts', 'Accounts', null, 'payments.edit'], ['#/payouts', 'Teacher payouts', null, 'payouts.view']]],
    ['Admin', [['#/review', 'Weekly review', null, 'audit.view'], ['#/users', 'Users & roles', null, 'users.manage'], ['#/settings', 'Settings', null, 'settings.manage']]],
  ];

  // Line icons for the phone tab bar and header (24px, stroke = currentColor).
  const ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/>',
    leads: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.6.8 2.7 2.5 3 5.2"/>',
    pipeline: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
    tasks: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="m8 12 2.5 2.5L16 9"/>',
    students: '<path d="M2.5 9 12 4.5 21.5 9 12 13.5z"/><path d="M6.5 11v5c1.5 1.6 3.4 2.5 5.5 2.5s4-.9 5.5-2.5v-5"/>',
    classes: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    accounts: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.5h18M7 15h4"/>',
    payouts: '<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2.1 0 3 5.8 1.5 5.8 4.3 0 1.3-1.3 2.2-3 2.2-1.3 0-2.5-.6-3-1.6M12 6.2v1.6M12 16.4V18"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v3.5M8.5 20h7M10 16.5h4l.5 3.5h-5z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    phone: '<path d="M5 3.5h3.5l1.8 4.5-2.3 1.4a11 11 0 0 0 6.6 6.6l1.4-2.3 4.5 1.8V19a1.5 1.5 0 0 1-1.6 1.5C10.4 20 4 13.6 3.5 5.1A1.5 1.5 0 0 1 5 3.5z"/>',
    chat: '<path d="M4 19.5 5.3 16A8 8 0 1 1 8 18.7z"/>',
    log: '<path d="M5 4h10l4 4v12H5z"/><path d="M9 12h6M9 16h4"/>',
  };
  const icon = (n, size = 22) => `<svg class="ico-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

  // Four role-specific tabs + Menu (opens the full module list).
  function bottomTabs() {
    const r = role();
    const sets = {
      sales_exec: [['#/dashboard', 'Home', 'home'], ['#/leads?view=today', 'Today', 'leads', 'today'], ['#/leaderboard', 'Board', 'trophy'], ['#/tasks', 'Tasks', 'tasks']],
      sales_manager: [['#/dashboard', 'Home', 'home'], ['#/leads', 'Leads', 'leads', 'overdue'], ['#/leaderboard', 'Board', 'trophy'], ['#/tasks', 'Tasks', 'tasks']],
      admin: [['#/dashboard', 'Home', 'home'], ['#/students', 'Students', 'students'], ['#/classes', 'Classes', 'classes'], ['#/tasks', 'Tasks', 'tasks']],
      accounts: [['#/dashboard', 'Home', 'home'], ['#/accounts', 'Accounts', 'accounts'], ['#/payouts', 'Payouts', 'payouts'], ['#/tasks', 'Tasks', 'tasks']],
    };
    const tabs = sets[r] || [['#/dashboard', 'Home', 'home'], ['#/leads', 'Leads', 'leads', 'overdue'], ['#/students', 'Students', 'students'], ['#/tasks', 'Tasks', 'tasks']];
    const path = location.hash.split('?')[0];
    return `<nav class="tabbar" aria-label="Main">${tabs.map(([href, label, ic, countKey]) => {
      const base = href.split('?')[0];
      const on = path === base || (base !== '#/dashboard' && path.startsWith(`${base}/`));
      const c = countKey && S.counts[countKey] ? `<span class="badge">${S.counts[countKey]}</span>` : '';
      return `<a href="${href}" class="${on ? 'on' : ''}" ${on ? 'aria-current="page"' : ''}>${icon(ic)}${c}<span>${label}</span></a>`;
    }).join('')}<button type="button" id="tab-menu">${icon('menu')}<span>Menu</span></button></nav>`;
  }

  function pageTitle() {
    const path = location.hash.split('?')[0];
    if (/^#\/leads\/\d+/.test(path)) return 'Lead';
    if (/^#\/students\/\d+/.test(path)) return 'Student';
    for (const [, items] of NAV) for (const [href, label] of items) if (path === href) return label;
    return 'Jeta Edu';
  }

  function layout(content) {
    const path = location.hash.split('?')[0];
    const nav = NAV.map(([g, items]) => {
      const links = items.filter(([, , , perm]) => !perm || can(perm)).map(([href, label, countKey]) => {
        const on = path === href || (href !== '#/dashboard' && path.startsWith(`${href}/`));
        const c = countKey && S.counts[countKey] ? `<span class="count">${S.counts[countKey]}</span>` : '';
        return `<a href="${href}" class="${on ? 'on' : ''}">${esc(label)}${c}</a>`;
      }).join('');
      return links ? `<div class="group">${g}</div>${links}` : '';
    }).join('');
    $('#app').innerHTML = `<div class="shell">
      <div class="scrim" id="scrim" hidden></div>
      <aside class="side" id="side"><div class="brand"><span class="mark">J</span> Jeta Edu CRM</div><nav class="nav">${nav}</nav>
        <div class="me"><div>${esc(S.me.name)}</div><div class="small" style="color:#9EC2B6">${esc(S.meta.roles[S.me.role])}${S.me.market ? ` · ${esc(S.me.market)}` : ''}</div>
        <button id="logout" class="small">Sign out</button></div></aside>
      <div class="main"><header class="top">
        <span class="top-title">${esc(pageTitle())}</span>
        <input class="search" id="gsearch" type="search" enterkeyhint="search" placeholder="Search leads by name, phone or ID" aria-label="Search leads">
        <div class="top-spacer"></div>
        <button class="icon-btn mobile-only" id="search-btn" aria-label="Search leads">${icon('search')}</button>
        ${can('leads.edit') ? `<button class="primary" id="quick-lead" aria-label="New lead">${icon('plus', 18)}<span class="desk-only">New lead</span></button>` : ''}
        <button class="bell icon-btn" id="bell" aria-label="Alerts">${icon('bell')}<span class="desk-only">Alerts</span><span class="dot" id="bell-dot" hidden></span></button>
      </header><main class="page" id="page">${content}</main></div>${bottomTabs()}</div>`;
    $('#logout').onclick = logout;
    $('#bell').onclick = openNotifications;
    $('#quick-lead') && ($('#quick-lead').onclick = newLeadModal);
    const gs = $('#gsearch');
    gs.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = `#/leads?view=all&search=${encodeURIComponent(e.target.value)}`; });
    $('#search-btn').onclick = () => { document.body.classList.toggle('searching'); if (document.body.classList.contains('searching')) gs.focus(); };
    gs.addEventListener('blur', () => { if (!gs.value) document.body.classList.remove('searching'); });
    const openMenu = (open) => { $('#side').classList.toggle('open', open); $('#scrim').hidden = !open; document.body.classList.toggle('locked', open); };
    $('#tab-menu').onclick = () => openMenu(true);
    $('#scrim').onclick = () => openMenu(false);
    $$('#side a').forEach((a) => a.addEventListener('click', () => openMenu(false)));
    document.body.classList.remove('searching', 'locked');
    refreshBell();
  }

  // Phone layout helpers run after every page render.
  // 1) Each table cell gets its column name, so CSS can show rows as labelled cards.
  // 2) Long filter bars collapse behind a "Filters" toggle.
  function mobilize(root) {
    $$('table', root).forEach((t) => {
      const heads = $$('thead th', t).map((th) => th.textContent.trim());
      t.classList.add('cardify');
      $$('tbody tr', t).forEach((tr) => {
        [...tr.children].forEach((td, i) => {
          if (td.tagName !== 'TD') return;
          if (heads[i] && !td.dataset.label) td.dataset.label = heads[i];
          const txt = td.textContent.trim();
          if ((!txt || txt === '—') && !td.querySelector('button,a,input,.pill,.mini-meter')) td.classList.add('blank');
        });
      });
    });
    $$('form.filters', root).forEach((f) => {
      if (f.previousElementSibling?.classList.contains('filter-toggle')) return;
      const controls = $$('input:not([type=hidden]), select', f).length;
      if (controls < 3) return;
      const active = $$('input:not([type=hidden]), select', f).filter((el) => el.value && el.name !== 'period').length;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'filter-toggle mobile-only';
      b.textContent = active ? `Filters (${active})` : 'Filters';
      b.setAttribute('aria-expanded', 'false');
      b.onclick = () => { const open = f.classList.toggle('open'); b.setAttribute('aria-expanded', String(open)); };
      f.before(b);
    });
    // Keep the current stage visible when the stage track scrolls sideways.
    $$('.stages', root).forEach((s) => { const cur = $('.cur', s); if (cur) s.scrollLeft = cur.offsetLeft - s.offsetLeft - 24; });
  }

  async function refreshBell() {
    try {
      const n = await get('/notifications');
      const dot = $('#bell-dot'); if (!dot) return;
      dot.hidden = !n.unread; dot.textContent = n.unread;
    } catch { /* ignore */ }
  }

  async function openNotifications() {
    const n = await get('/notifications');
    const root = $('#modal-root');
    root.innerHTML = `<div class="overlay" style="background:transparent;place-items:stretch"><aside class="drawer">
      <div class="panel-head" style="padding:14px 16px;margin:0;border-bottom:1px solid var(--line)"><h2>Alerts</h2>
      <div><button class="link" id="mark-read">Mark all read</button> &nbsp; <button class="link" id="close-d">Close</button></div></div>
      <div class="list">${n.items.length ? n.items.map((x) => `<a class="notif ${x.read ? '' : 'unread'}" href="${esc(x.link || '#/dashboard')}">
        <div><b>${esc(x.title)}</b></div><div class="small">${esc(x.body)}</div><div class="small muted">${ago(x.created_at)}</div></a>`).join('')
    : '<div class="empty">No alerts. SLA breaches, overdue follow-ups and hours alerts show up here.</div>'}</div></aside></div>`;
    const close = () => { root.innerHTML = ''; };
    $('#close-d').onclick = close;
    $('.overlay', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('overlay')) close(); });
    $$('.notif', root).forEach((a) => a.addEventListener('click', close));
    $('#mark-read').onclick = async () => { await post('/notifications/read'); close(); refreshBell(); };
  }

  // ---------------- router ----------------
  const ROUTES = [
    [/^#\/dashboard$/, pageDashboard], [/^#\/leads$/, pageLeads], [/^#\/leads\/(\d+)$/, pageLead], [/^#\/pipeline$/, pagePipeline],
    [/^#\/students$/, pageStudents], [/^#\/students\/(\d+)$/, pageStudent], [/^#\/classes$/, pageClasses],
    [/^#\/teachers$/, pageTeachers], [/^#\/accounts$/, pageAccounts], [/^#\/payouts$/, pagePayouts],
    [/^#\/tasks$/, pageTasks], [/^#\/users$/, pageUsers], [/^#\/leaderboard$/, pageLeaderboard],
    [/^#\/scorecard$/, pageScorecard], [/^#\/review$/, pageReview], [/^#\/phone$/, pagePhone], [/^#\/settings$/, pageSettings],
  ];
  const qs = () => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
  async function route() {
    if (!S.me) return;
    const path = location.hash.split('?')[0];
    const match = ROUTES.map(([re, fn]) => [path.match(re), fn]).find(([m]) => m);
    if (!match) { location.hash = '#/dashboard'; return; }
    try { S.counts = await get('/leads/counts'); } catch { /* ignore */ }
    layout('<div class="empty">Loading…</div>');
    try { await match[1](...match[0].slice(1)); } catch (e) { $('#page').innerHTML = `<div class="callout red">${esc(e.message)}</div>`; }
  }
  window.addEventListener('hashchange', route);
  const reload = () => route();
  const setPage = (html) => { const p = $('#page'); p.innerHTML = html; mobilize(p); };

  // ---------------- dashboard ----------------
  function barList(obj, fmt = (v) => v) {
    const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '<div class="muted small">No data in this period.</div>';
    const max = Math.max(...entries.map((e) => e[1])) || 1;
    return `<div class="bars">${entries.map(([k, v]) => `<div class="bar"><span class="lbl" title="${esc(k)}">${esc(k)}</span>
      <span class="track"><span class="fill" style="width:${(v / max) * 100}%"></span></span><span class="val">${esc(fmt(v))}</span></div>`).join('')}</div>`;
  }
  const kpi = (v, l, warn) => `<div class="kpi ${warn ? 'warn' : ''}"><div class="v">${esc(v ?? '—')}</div><div class="l">${esc(l)}</div></div>`;
  const tri = (m) => `AED ${Number(m.AED).toLocaleString()} · INR ${Number(m.INR).toLocaleString()}`;

  async function pageDashboard() {
    const p = qs();
    const query = new URLSearchParams({ period: p.period || 'month', ...(p.rep && { rep: p.rep }), ...(p.country && { country: p.country }), ...(p.source && { source: p.source }), ...(p.from && { from: p.from, to: p.to }) });
    const x = await get(`/dashboard?${query}`);
    const team = can('dashboard.team') ? await get('/reports/team') : [];
    const calls = can('game.view') ? await get(`/call-metrics?period=week${p.rep ? `&rep=${p.rep}` : ''}`).catch(() => null) : null;
    const periods = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom']];
    const gameCard = can('game.view') ? await dashGameCard() : '';
    setPage(`${gameCard}<div class="page-head"><div><h1>Dashboard</h1><div class="muted">${d(x.range.from)} – ${d(new Date(new Date(x.range.to) - 1).toISOString())}${role() === 'sales_exec' ? ' · your numbers' : ''}</div></div></div>
      <form class="filters" id="dash-f">
        ${select('period', periods, p.period || 'month')}
        <input type="date" name="from" value="${esc(p.from || '')}" ${p.period === 'custom' ? '' : 'hidden'}><input type="date" name="to" value="${esc(p.to || '')}" ${p.period === 'custom' ? '' : 'hidden'}>
        ${role() !== 'sales_exec' ? select('rep', salesUsers(), p.rep, 'All reps') : ''}
        ${select('country', ['UAE', 'India'], p.country, 'All markets')}
        ${select('source', S.meta.leadSources, p.source, 'All sources')}
        <button class="primary">Apply</button></form>

      <h2>Sales activity</h2>
      <div class="kpis">${kpi(x.sales.dials, 'Total dials')}${kpi(x.sales.connected, 'Connected calls')}${kpi(x.sales.notAnswered, 'Not answered')}
        ${kpi(`${x.sales.whatsappSent} / ${x.sales.whatsappReplied}`, 'WhatsApp sent / replied')}${kpi(`${x.sales.talkMinutes} min`, 'Talk time')}
        ${kpi(x.sales.slaPct === null ? '—' : `${x.sales.slaPct}%`, 'First-call SLA met', x.sales.slaPct !== null && x.sales.slaPct < 80)}
        ${kpi(x.sales.notesPct === null ? '—' : `${x.sales.notesPct}%`, 'Notes completed', x.sales.notesPct !== null && x.sales.notesPct < (S.settings?.compliance?.notesPct || 90))}
        ${kpi(x.sales.followUpsDueToday, 'Follow-ups due today')}${kpi(x.sales.followUpsOverdue, 'Follow-ups overdue', x.sales.followUpsOverdue > 0)}</div>
      ${calls ? `<div class="panel"><div class="panel-head"><h2>Call analytics · this week</h2><span class="small muted">${calls.trackedShare}% of calls measured by phone tracker / telephony</span></div>
        <div class="kpis" style="margin:0 0 10px">${kpi(calls.avgCallMinutes === null ? '—' : `${calls.avgCallMinutes} min`, 'Average call')}${kpi(calls.uniqueLeads, 'Unique leads called')}
          ${kpi(calls.missedIncoming, 'Missed incoming', calls.missedIncoming > 0)}${kpi(calls.missingNotes, 'Calls missing notes', calls.missingNotes > 0)}
          ${kpi(calls.firstCallAvg || '—', 'Avg first call')}${kpi(calls.maxIdleGapAvgMin === null ? '—' : `${calls.maxIdleGapAvgMin} min`, 'Longest idle gap (avg/day)')}
          ${kpi(calls.callsPerConversion ?? '—', 'Calls per conversion')}</div>
        <div class="small">Best calling hours: ${calls.bestHours.length ? calls.bestHours.map((h) => `<b>${esc(h.label)}</b> (${h.rate}% connect)`).join(' · ') : 'not enough calls yet'}</div></div>` : ''}

      <div class="dash-grid">
        <div class="panel"><div class="panel-head"><h2>Conversion</h2><span class="muted small">${x.pipeline.newLeads} new leads</span></div>
          <div class="funnel"><div><b>${x.pipeline.leadToDemo}%</b><span class="small muted">Lead → demo</span></div><div><b>${x.pipeline.demoToPaid}%</b><span class="small muted">Demo → paid</span></div><div><b>${x.pipeline.leadToPaid}%</b><span class="small muted">Lead → paid</span></div></div>
          <p class="small" style="margin:12px 0 0"><a href="#/leads?view=expiring">${x.pipeline.expiringIn5Days} leads expiring in 5 days</a> · ${x.pipeline.reassigned} reassigned</p></div>
        <div class="panel"><h2>New leads by source</h2>${barList(x.pipeline.bySource)}</div>
        <div class="panel"><h2>Open pipeline by stage</h2>${barList(Object.fromEntries(Object.entries(x.pipeline.byStage).filter(([k]) => !['Converted', 'Lost'].includes(k))))}</div>
        <div class="panel"><h2>Lost leads by reason</h2>${barList(x.pipeline.lostByReason)}</div>
      </div>

      <h2 style="margin-top:22px">Revenue</h2>
      <div class="kpis">${kpi(money(x.revenue.total.combinedAED, 'AED'), 'Total (combined)')}${kpi(money(x.revenue.total.AED, 'AED'), 'UAE revenue')}${kpi(money(x.revenue.total.INR, 'INR'), 'India revenue')}
        ${kpi(money(x.revenue.new.combinedAED, 'AED'), 'New')}${kpi(money(x.revenue.renewal.combinedAED, 'AED'), 'Renewal')}
        ${kpi(money(x.revenue.outstanding.combinedAED, 'AED'), 'Outstanding', x.revenue.outstanding.combinedAED > 0)}${kpi(money(x.revenue.mrrAED, 'AED'), 'Last 30 days (MRR)')}${kpi(money(x.revenue.avgDealAED, 'AED'), 'Average deal')}</div>
      <div class="dash-grid">
        <div class="panel"><h2>Revenue by rep (AED)</h2>${barList(x.revenue.byRepAED, (v) => Math.round(v).toLocaleString())}</div>
        <div class="panel"><h2>Revenue by source (AED)</h2>${barList(x.revenue.bySourceAED, (v) => Math.round(v).toLocaleString())}</div>
        <div class="panel"><h2>Retention</h2><div class="kpis" style="margin:0">${kpi(x.retention.dueForRenewal, 'Due for renewal')}${kpi(x.retention.renewals, 'Renewals')}${kpi(x.retention.renewalRate === null ? '—' : `${x.retention.renewalRate}%`, 'Renewal rate')}${kpi(x.retention.churned, 'Churned', x.retention.churned > 0)}</div>
          <div style="margin-top:12px">${barList(x.retention.churnReasons)}</div></div>
        <div class="panel"><h2>Academics</h2><div class="kpis" style="margin:0">${kpi(x.academics.active, 'Active students')}${kpi(x.academics.unassigned, 'Awaiting teacher', x.academics.unassigned > 0)}${kpi(x.academics.classesHeld, 'Classes held')}
          ${kpi(x.academics.attendancePct === null ? '—' : `${x.academics.attendancePct}%`, 'Attendance')}${kpi(x.academics.teacherAbsences, 'Teacher absences')}${kpi(x.academics.hoursConsumed, 'Hours consumed')}</div>
          ${x.academics.unmarked ? `<p class="small" style="margin:10px 0 0"><a href="#/classes?filter=unmarked">${x.academics.unmarked} past classes still unmarked</a></p>` : ''}</div>
        ${can('payouts.view') ? `<div class="panel"><h2>Payouts · ${esc(x.payouts.month)}</h2><dl class="fields"><dt>Payable</dt><dd class="num">${tri(x.payouts.payable)}</dd>
          <dt>Paid</dt><dd class="num">${tri(x.payouts.paid)}</dd><dt>Pending</dt><dd class="num">${tri(x.payouts.pending)}</dd>
          <dt>% of revenue</dt><dd>${x.payouts.pctOfRevenue === null ? '—' : `${x.payouts.pctOfRevenue}%`}</dd></dl></div>` : ''}
      </div>
      ${team.length ? `<h2 style="margin-top:22px">Team</h2><div class="table-wrap"><table><thead><tr><th>Rep</th><th>Market</th><th class="r">Open leads</th><th class="r">Overdue follow-ups</th><th class="r">Calls today</th><th class="r">Converted this month</th><th>Assignment</th></tr></thead><tbody>
        ${team.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.market || '—')}</td><td class="r num">${t.openLeads}</td><td class="r num ${t.overdue ? 'due-over' : ''}">${t.overdue}</td><td class="r num">${t.callsToday}</td><td class="r num">${t.convertedMonth}</td><td>${t.blocked ? pill('Blocked – overdue limit') : '<span class="pill green">Receiving leads</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <p class="muted small" style="margin-top:16px">Combined totals use 1 AED = ${x.exchangeRate.INR_PER_AED} INR.</p>`);
    const f = $('#dash-f');
    f.period.onchange = () => { $$('input[type=date]', f).forEach((i) => { i.hidden = f.period.value !== 'custom'; }); };
    f.onsubmit = (e) => { e.preventDefault(); const o = formData(f); location.hash = `#/dashboard?${new URLSearchParams(Object.entries(o).filter(([, v]) => v))}`; };
  }

  // ---------------- leads ----------------
  function newLeadModal() {
    const reps = ['owner', 'sales_manager'].includes(role()) ? field('Lead owner', select('owner_id', salesUsers(), '', 'Auto-assign (round-robin)')) : '';
    modal({
      title: 'New lead', submit: 'Create lead', wide: true,
      body: `<div class="grid3">${field('Source *', select('source', S.meta.leadSources, '', 'Choose source', 'required'))}${field('Campaign', input('campaign'))}${field('Ad set / UTM', input('ad_set'))}</div>
        <div class="grid3">${field('Parent name *', input('parent_name', '', 'text', 'required'))}${field('Phone *', input('phone', '', 'tel', 'required placeholder="+971…"'))}${field('Email', input('email', '', 'email'))}</div>
        <div class="grid3">${field('Country', select('country', ['UAE', 'India'], 'UAE'))}${field('City / Emirate', input('city'))}${field('Referred by', input('referral_by'))}</div>
        <label class="check"><input type="checkbox" name="is_whatsapp" checked> Phone is on WhatsApp</label>
        <div class="grid3">${field('Child name', input('child_name'))}${field('Grade', input('grade'))}${field('Board', select('board', S.meta.boards, '', '—'))}</div>
        <div class="grid2">${field('Subjects needed', input('subjects', '', 'text', 'placeholder="Maths, Physics"'))}${field('Lead score', select('score', ['Hot', 'Warm', 'Cold'], 'Warm'))}</div>${reps}`,
      onSubmit: async (f) => {
        try {
          const l = await post('/leads', f);
          toast(`Lead ${l.code} created${l.owner_id ? '' : ' – no rep available'}`); location.hash = `#/leads/${l.id}`;
        } catch (e) {
          const d = e.data?.duplicate;
          if (d && (d.owner_id === S.me.id || can('leads.view_all'))) {
            $('#modal-root').innerHTML = '';
            toast('That number is already in the CRM – opening the existing lead');
            location.hash = `#/leads/${d.id}`;
            return;
          }
          throw e;
        }
      },
    });
  }

  // Bulk CSV upload (blueprint 4.1 / 4.3): duplicates by phone are skipped and reported.
  function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let qt = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (qt) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') qt = false; else cell += ch; }
      else if (ch === '"') qt = true;
      else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const clean = rows.filter((r) => r.some((c) => c.trim()));
    const head = (clean.shift() || []).map((h) => h.trim());
    return clean.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
  }
  function importModal() {
    const isMgr = can('leads.reassign');
    modal({
      title: 'Import leads from CSV', submit: 'Import', wide: true,
      body: `<p class="small muted">Columns (header row): <b>parent_name, phone</b> required; optional source, campaign, ad_set, email, city, country, child_name, grade, board, subjects, score, referral_by.
        A number already in the CRM is skipped and listed in the report. <a href="#" id="csv-tpl">Download template</a></p>
        ${field('CSV file', '<input type="file" name="file" accept=".csv,text/csv" required id="csv-file">')}
        <div id="csv-prev" class="callout" hidden></div>
        <div class="grid2">${field('Source for rows without one', select('default_source', S.meta.leadSources, 'Meta Ads'))}
        ${isMgr ? field('Assign to', select('owner_id', salesUsers(), '', 'Round-robin by market')) : '<div></div>'}</div>`,
      onOpen: (form) => {
        let rows = [];
        $('#csv-tpl', form).onclick = (e) => {
          e.preventDefault();
          const blob = new Blob(['parent_name,phone,email,source,campaign,country,city,child_name,grade,board,subjects\nFathima K,+971501234567,fathima@example.com,Meta Ads,Oct Exam Prep,UAE,Dubai,Aarav,8,CBSE,Maths\n'], { type: 'text/csv' });
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'leads-template.csv'; a.click();
        };
        $('#csv-file', form).onchange = async (e) => {
          const f = e.target.files[0]; if (!f) return;
          rows = parseCsv(await f.text());
          const prev = $('#csv-prev', form); prev.hidden = false;
          prev.textContent = rows.length ? `${rows.length} rows found. Columns: ${Object.keys(rows[0]).join(', ')}` : 'No rows found – check the header row.';
          form.dataset.rows = JSON.stringify(rows);
        };
      },
      onSubmit: async (f, form) => {
        const rows = JSON.parse(form.dataset.rows || '[]');
        if (!rows.length) throw new Error('Choose a CSV file with at least one row');
        const r = await post('/leads/import', { rows, default_source: f.default_source, owner_id: f.owner_id });
        setTimeout(() => modal({ title: 'Import report', body: `<div class="kpis" style="margin-bottom:12px">${kpi(r.created, 'Leads created')}${kpi(r.duplicates.length, 'Duplicates skipped', r.duplicates.length > 0)}${kpi(r.errors.length, 'Rows with errors', r.errors.length > 0)}</div>
          ${r.duplicates.length ? `<h3>Skipped – already in the CRM</h3><div class="table-wrap" style="margin-bottom:12px"><table><thead><tr><th>Row</th><th>Phone</th><th>Existing lead</th></tr></thead><tbody>${r.duplicates.map((d) => `<tr><td>${d.row}</td><td>${esc(d.phone)}</td><td>${d.lead_id ? `<a href="#/leads/${d.lead_id}">${esc(d.existing)}</a>` : esc(d.existing)}</td></tr>`).join('')}</tbody></table></div>` : ''}
          ${r.errors.length ? `<h3>Errors</h3><div class="table-wrap"><table><thead><tr><th>Row</th><th>Problem</th></tr></thead><tbody>${r.errors.map((d) => `<tr><td>${d.row}</td><td>${esc(d.error)}</td></tr>`).join('')}</tbody></table></div>` : ''}` }), 50);
        reload();
      },
    });
  }

  // Responsibility rule: no action beyond SLA turns the row red (48h untouched, or escalated).
  const staleCls = (l) => (['Converted', 'Lost'].includes(l.stage) ? '' : (l.escalated || (Date.now() - new Date(l.last_action_at || l.last_contacted_at || l.created_at)) > 48 * 3600000) ? 'due-over' : '');

  async function pageLeads() {
    const p = qs();
    const view = p.view || 'open';
    const params = new URLSearchParams({ view, ...p });
    const rows = await get(`/leads?${params}`);
    const views = [['open', 'All open'], ['today', "Today's follow-ups", 'today'], ['overdue', 'Overdue', 'overdue', true], ['escalated', 'Escalated 48h', 'escalated', true], ['upcoming', 'Next 7 days', 'upcoming'],
      ['untouched', 'Not touched 48h', 'untouched', true], ['expiring', 'Expiring (day 25+)', 'expiring', true], ['nurture', 'Nurture'], ['flagged', 'Flagged'], ['all', 'All leads'],
      ...(can('leads.reassign') ? [['archived', 'Archived']] : [])];
    setPage(`<div class="page-head"><div><h1>Leads</h1><div class="muted">${rows.length} shown${role() === 'sales_exec' ? ' · your leads' : ''}</div></div>
      <div class="actions">${can('exports') ? '<button id="exp">Export CSV</button>' : ''}${can('leads.edit') ? '<button id="imp">Import CSV</button>' : ''}<a class="btn" href="#/pipeline">Pipeline view</a>${can('leads.edit') ? '<button class="primary" id="nl">New lead</button>' : ''}</div></div>
      ${S.counts.missingNotes ? `<div class="callout red">${S.counts.missingNotes} tracked call${S.counts.missingNotes > 1 ? 's' : ''} still need notes. Open the lead and use <b>Add notes</b> on the call.</div>` : ''}
      <nav class="views">${views.map(([v, l, ck, alert]) => `<a href="#/leads?view=${v}" class="${v === view ? 'on' : ''} ${alert && S.counts[ck] ? 'alert' : ''}">${l}${ck ? `<span class="n">${S.counts[ck] ?? 0}</span>` : ''}</a>`).join('')}</nav>
      <form class="filters" id="lf"><input type="hidden" name="view" value="${esc(view)}">
        <input name="search" placeholder="Name, phone, ID" value="${esc(p.search || '')}">
        ${select('stage', S.meta.leadStages, p.stage, 'Any stage')}${select('source', S.meta.leadSources, p.source, 'Any source')}
        ${role() !== 'sales_exec' ? select('owner', salesUsers(), p.owner, 'Any owner') : ''}${select('country', ['UAE', 'India'], p.country, 'Any market')}
        ${select('score', ['Hot', 'Warm', 'Cold'], p.score, 'Any score')}<button>Filter</button></form>
      <div class="table-wrap">${rows.length ? `<table class="lead-table"><thead><tr><th>Lead</th><th>Child</th><th>Source</th><th>Stage</th><th>Score</th><th>Owner</th><th>Next follow-up</th><th class="r">Attempts</th><th>Last action</th></tr></thead><tbody>
        ${rows.map((l) => `<tr class="click" data-href="#/leads/${l.id}"><td><a href="#/leads/${l.id}"><b>${esc(l.parent_name)}</b></a>${l.flagged ? ' ' + pill('Flagged') : ''}<div class="small muted">${esc(l.code)} · ${esc(l.phone)}</div></td>
          <td>${esc(l.child_name || '—')}<div class="small muted">${esc([l.grade && `Gr ${l.grade}`, l.board, l.subjects].filter(Boolean).join(' · '))}</div></td>
          <td>${esc(l.source)}<div class="small muted">${esc(l.country)}</div></td><td>${pill(l.stage)}</td><td>${pill(l.score)}</td><td>${esc(l.owner_name || 'Unassigned')}</td>
          <td>${['Converted', 'Lost'].includes(l.stage) ? '—' : dueCell(l.next_follow_up_at)}</td><td class="r num">${l.attempt_count}</td>
          <td class="small ${staleCls(l)}">${ago(l.last_action_at || l.last_contacted_at || l.created_at)}${l.escalated ? ' · escalated' : ''}<div class="muted">assigned ${ago(l.assigned_at)}${l.reassignment_count ? ` · reassigned ${l.reassignment_count}×` : ''}</div></td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No leads in this view. Change the filters or add a new lead.</div>'}</div>`);
    $('#nl') && ($('#nl').onclick = newLeadModal);
    $('#imp') && ($('#imp').onclick = importModal);
    $('#exp') && ($('#exp').onclick = () => openDoc('/export/leads.csv', 'leads.csv'));
    $('#lf').onsubmit = (e) => { e.preventDefault(); location.hash = `#/leads?${new URLSearchParams(Object.entries(formData(e.target)).filter(([, v]) => v))}`; };
    $$('tr.click').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.tagName !== 'A') location.hash = tr.dataset.href; }));
  }

  async function pagePipeline() {
    const rows = await get('/leads?view=all');
    const cols = S.meta.leadStages.filter((s) => s !== 'Lost');
    setPage(`<div class="page-head"><div><h1>Pipeline</h1><div class="muted">Converted and Lost stages hidden after 30 days</div></div><div class="actions"><a class="btn" href="#/leads">List view</a></div></div>
      <div class="board">${cols.map((c) => {
        const items = rows.filter((l) => l.stage === c && (c !== 'Converted' || (Date.now() - new Date(l.updated_at)) < 30 * 864e5));
        return `<div class="col"><h3><span>${esc(c)}</span><span class="muted">${items.length}</span></h3>${items.slice(0, 60).map((l) => `<div class="card" data-href="#/leads/${l.id}">
          <b>${esc(l.parent_name)}</b><span class="small muted">${esc(l.child_name || '')} ${l.grade ? `· Gr ${esc(l.grade)}` : ''} · ${esc(l.country)}</span>
          <div class="small" style="margin-top:4px">${['Converted'].includes(c) ? esc(l.owner_name || '') : dueCell(l.next_follow_up_at)}</div></div>`).join('')}</div>`;
      }).join('')}</div>`);
    $$('.card').forEach((c) => c.addEventListener('click', () => { location.hash = c.dataset.href; }));
  }

  const QUESTIONS = [
    ['child', "Child's name and grade / board (CBSE/ICSE, school name)"],
    ['parent', "Parent's name and profession (helps tone and timings)"],
    ['subjects', 'Which subjects need support, and the main problem (marks, concepts, exam prep, homework)'],
    ['current', "Current tuition / coaching and what isn't working"],
    ['timing', 'Preferred timings, days and budget comfort (5 / 15 / 20 hrs)'],
    ['decision', 'Who decides, and when do they want to start'],
    ['summary', 'Call summary'], ['objections', 'Objections'], ['next_step', 'Next step'], ['demo_pref', 'Demo preference'],
  ];
  const ICON = { call: 'C', whatsapp: 'W', note: 'N', stage: 'S', reassign: 'R', system: '·', kyc: 'K', payment: '$', class: 'L', demo: 'D', email: '@', walkin: 'V' };
  const EDITABLE = ['note', 'call', 'whatsapp', 'demo', 'email', 'walkin'];
  // Conversation log: entries are never deleted; edits keep versions (author within 24h, then manager approval).
  const timeline = (acts) => (acts.length ? `<ul class="timeline">${acts.map((a) => {
    const m = (() => { try { return JSON.parse(a.meta || '{}'); } catch { return {}; } })();
    const chips = [a.direction === 'inbound' ? 'Inbound' : null, a.source === 'tracker' ? 'Phone tracker' : a.source === 'telephony' ? 'Telephony' : null,
      m.duration_sec ? `${Math.round(m.duration_sec / 60)} min` : m.duration_min ? `${m.duration_min} min` : null, m.sentiment, ...(m.objections || []).map((o) => `Objection: ${o}`)].filter(Boolean);
    const canEdit = EDITABLE.includes(a.type) && !a.needs_note && a.user_id && (a.user_id === S.me.id || can('leads.reassign'));
    return `<li><span class="ico ${a.type}">${ICON[a.type] || '·'}</span><div>
    <div class="when">${dt(a.created_at)} · ${esc(a.user_name || 'System')}${a.outcome ? ` · <b>${esc(a.outcome)}</b>` : ''}${a.version > 1 ? ` · <button class="link small" data-ver="${a.id}">edited</button>` : ''}</div>
    ${a.needs_note ? `<div class="callout red" style="margin:6px 0">Tracked call – add the outcome and notes. <button class="small primary" data-complete="${a.id}">Add notes</button></div>` : `<div class="body">${esc(a.body || '')}</div>`}
    ${m.next_step ? `<div class="small"><b>Next step:</b> ${esc(m.next_step)}</div>` : ''}
    ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
    ${m.recording_url ? `<div class="small"><a href="${esc(m.recording_url)}" target="_blank" rel="noopener">Recording</a></div>` : ''}
    ${canEdit ? `<button class="link small edit-act" data-edit="${a.id}">Edit</button>` : ''}</div></li>`;
  }).join('')}</ul>` : '<div class="muted small">Nothing logged yet.</div>');

  function bindTimeline(acts, onTracked) {
    $$('[data-edit]').forEach((b) => { b.onclick = () => {
      const a = acts.find((x) => String(x.id) === b.dataset.edit);
      const ownFresh = a.user_id === S.me.id && (Date.now() - new Date(a.created_at)) < 24 * 3600000;
      modal({ title: 'Edit entry', submit: ownFresh || can('leads.reassign') ? 'Save edit' : 'Send for approval',
        body: `<p class="small muted">${ownFresh ? 'You can edit your own entries for 24 hours. The previous version is kept.' : can('leads.reassign') ? 'Managers can edit with a reason. The previous version is kept.' : 'This entry is older than 24 hours, so a manager has to approve the change. The original stays on record.'}</p>
          ${field('Text', `<textarea name="body" required>${esc(a.body || '')}</textarea>`)}${ownFresh ? field('Reason (optional)', input('reason')) : field('Reason *', input('reason', '', 'text', 'required'))}`,
        onSubmit: async (f) => { const r = await api('PATCH', `/activities/${a.id}`, f); toast(r.pending ? 'Sent to your manager for approval' : 'Entry updated – old version kept'); reload(); } });
    }; });
    $$('[data-ver]').forEach((b) => { b.onclick = async () => {
      const v = await get(`/activities/${b.dataset.ver}/versions`);
      modal({ title: 'Previous versions', body: v.length ? `<ul class="timeline">${v.map((x) => `<li><span class="ico note">v</span><div><div class="when">${dt(x.created_at)} · changed by ${esc(x.edited_by_name || '—')}${x.reason ? ` · ${esc(x.reason)}` : ''}</div><div class="body">${esc(x.body || '')}</div></div></li>`).join('')}</ul>` : '<div class="muted">No earlier versions.</div>' });
    }; });
    $$('[data-complete]').forEach((b) => { b.onclick = () => onTracked && onTracked(Number(b.dataset.complete)); });
  }

  // Tap-to-call and WhatsApp for a parent number. wa.me needs digits only.
  const waLink = (phone) => `https://wa.me/${String(phone || '').replace(/\D/g, '')}`;
  const contactLinks = (phone, isWa = true) => `<a href="tel:${esc(phone)}">${esc(phone)}</a>${isWa ? ` · <a href="${waLink(phone)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}`;
  const actionBar = (phone, isWa, logId, logLabel = 'Log call') => `<div class="actionbar mobile-only" role="toolbar" aria-label="Contact">
    <a class="btn" href="tel:${esc(phone)}">${icon('phone', 18)}<span>Call</span></a>
    ${isWa ? `<a class="btn" href="${waLink(phone)}" target="_blank" rel="noopener">${icon('chat', 18)}<span>WhatsApp</span></a>` : ''}
    ${logId ? `<button class="primary" id="${logId}">${icon('log', 18)}<span>${esc(logLabel)}</span></button>` : ''}</div>`;

  async function pageLead(id) {
    const x = await get(`/leads/${id}`);
    const l = x.lead; const k = x.kyc;
    const closed = ['Converted', 'Lost'].includes(l.stage);
    const editable = can('leads.edit') && l.stage !== 'Converted';
    const track = ['New', 'Attempted', 'Contacted', 'Qualified', 'Demo Scheduled', 'Demo Done', 'Negotiation', 'Payment Pending', 'Converted'];
    const ci = track.indexOf(l.stage);
    const stageTrack = `<div class="stages ${l.stage === 'Lost' ? 'lost' : ''}">${track.map((s, i) => `<span class="${s === l.stage ? 'cur' : ci > i ? 'done' : ''}">${esc(s)}</span>`).join('')}
      ${['Lost', 'Nurture'].includes(l.stage) ? `<span class="cur">${esc(l.stage)}${l.lost_reason ? `: ${esc(l.lost_reason)}` : ''}</span>` : ''}</div>`;
    const age = l.assigned_at ? Math.floor((Date.now() - new Date(l.assigned_at)) / 864e5) : null;
    const answers = l.notes_template || {};
    const ck = x.checklist;

    setPage(`<a class="back" href="#/leads">Back to leads</a>
      <div class="record-head"><div class="row1"><div><h1>${esc(l.parent_name)} ${pill(l.score)} ${l.flagged ? pill(`Flagged: ${l.flag_reason}`) : ''}</h1>
        <div class="muted">${esc(l.code)} · ${contactLinks(l.phone, l.is_whatsapp)}${l.email ? ` · ${esc(l.email)}` : ''}</div></div>
        <div class="actions record-actions">${editable ? `<button class="primary" id="a-call">Log call</button><button id="a-wa">Log WhatsApp</button>
          ${!closed ? '<button id="a-stage">Change stage</button><button id="a-fu">Set follow-up</button>' : ''}
          ${l.stage === 'Lost' ? '<button id="a-reopen">Reopen</button>' : ''}
          ${!closed ? '<button id="a-conv">Convert</button>' : ''}` : ''}
          ${editable && !closed ? '<button id="a-int">Log demo / email / walk-in</button>' : ''}
          ${can('leads.reassign') && !closed ? '<button id="a-re">Reassign</button><button id="a-ex">Exempt 30-day</button>' : ''}
          ${can('leads.reassign') && !l.student_id ? `<button id="a-merge">Merge</button>${l.archived ? '<button id="a-restore">Restore</button>' : '<button id="a-arch" class="danger">Archive</button>'}` : ''}
          ${l.student_id ? `<a class="btn" href="#/students/${l.student_id}">Open student</a>` : ''}</div></div>
        <div class="meta"><span>Owner <b>${esc(l.owner_name || 'Unassigned')}</b></span><span>Next follow-up <b>${closed ? '—' : dueCell(l.next_follow_up_at)}</b> ${l.next_follow_up_type ? `<span class="muted">(${esc(l.next_follow_up_type)})</span>` : ''}</span>
          <span>Attempts <b>${l.attempt_count}</b></span><span>Assigned <b>${age === null ? '—' : `day ${age} of 30`}</b>${l.reassignment_count ? ` · reassigned ${l.reassignment_count}×` : ''}</span>
          <span>Source <b>${esc(l.source)}</b>${l.campaign ? ` / ${esc(l.campaign)}` : ''}</span><span>Market <b>${esc(l.country)} (${esc(l.currency)})</b></span></div>
        ${stageTrack}</div>
      ${x.activities.filter((a) => a.needs_note).map((a) => `<div class="callout red">Tracked call ${dt(a.created_at)}${(() => { try { const m = JSON.parse(a.meta || '{}'); return m.duration_sec ? ` · ${Math.round(m.duration_sec / 60)} min` : ''; } catch { return ''; } })()} has no notes yet. Add them within 10 minutes. <button class="small primary" data-complete="${a.id}">Add notes</button></div>`).join('')}
      ${l.archived ? `<div class="callout red">Archived${l.merged_into ? ` – merged into <a href="#/leads/${l.merged_into}">another lead</a>` : ''}. History is kept; it is hidden from lists.</div>` : ''}
      ${l.escalated ? '<div class="callout red">Escalated: the follow-up has been overdue for 48 hours. A manager should take over or reassign.</div>' : ''}
      ${x.duplicates.filter((d) => !d.archived).length ? `<div class="callout">Same phone number on ${x.duplicates.filter((d) => !d.archived).map((d) => `<a href="#/leads/${d.id}">${esc(d.code)}</a>`).join(', ')}.${can('leads.reassign') ? ' Use Merge to combine them.' : ' Ask your manager to merge.'}</div>` : ''}
      ${l.exempt_until && l.exempt_until > new Date().toISOString() ? `<div class="callout green">Exempt from auto-reassignment until ${d(l.exempt_until)}: ${esc(l.exempt_reason)}</div>` : ''}
      ${l.sla_breached && !l.first_call_at ? '<div class="callout red">First-call SLA breached – no call logged within 15 minutes of assignment.</div>' : ''}
      ${age !== null && age >= 25 && !closed && l.stage !== 'Nurture' ? `<div class="callout">This lead auto-reassigns on day 30 unless converted${['Payment Pending', 'Demo Scheduled'].includes(l.stage) ? ' (currently exempt)' : ''}.</div>` : ''}
      <div class="record"><div>
        <div class="tabs" role="tablist">${['Details', 'Call notes', 'KYC', 'Conversion', 'Tasks'].map((t, i) => `<button type="button" data-tab="${i}" class="${i === 0 ? 'on' : ''}">${t}${t === 'KYC' ? ` ${pill(k.status)}` : ''}</button>`).join('')}</div>
        <div data-pane="0" class="panel"><div class="panel-head"><h2>Lead details</h2>${editable ? '<button id="a-edit">Edit</button>' : ''}</div><dl class="fields">
          <dt>Parent</dt><dd>${esc(l.parent_name)}</dd><dt>Phone</dt><dd>${esc(l.phone)}</dd><dt>Email</dt><dd>${esc(l.email || '—')}</dd><dt>City / Emirate</dt><dd>${esc(l.city || '—')}</dd>
          <dt>Child</dt><dd>${esc(l.child_name || '—')}</dd><dt>Grade / Board</dt><dd>${esc(l.grade || '—')} / ${esc(l.board || '—')}</dd><dt>Subjects</dt><dd>${esc(l.subjects || '—')}</dd>
          <dt>Source</dt><dd>${esc(l.source)}${l.referral_by ? ` – referred by ${esc(l.referral_by)}` : ''}</dd><dt>Campaign / Ad set</dt><dd>${esc(l.campaign || '—')} / ${esc(l.ad_set || '—')}</dd><dt>UTM</dt><dd>${esc(l.utm || '—')}</dd>
          <dt>Created</dt><dd>${dt(l.created_at)}</dd><dt>First call</dt><dd>${dt(l.first_call_at)}</dd><dt>Last contacted</dt><dd>${dt(l.last_contacted_at)}</dd>
          ${l.demo_at ? `<dt>Demo</dt><dd>${dt(l.demo_at)}</dd>` : ''}${l.lost_reason ? `<dt>Lost reason</dt><dd>${esc(l.lost_reason)}</dd>` : ''}</dl></div>
        <form data-pane="1" class="panel" hidden id="notes-f"><h2>Preset call questions</h2>
          ${QUESTIONS.map(([key, q]) => field(q, `<textarea name="${key}" ${editable ? '' : 'disabled'}>${esc(answers[key] || '')}</textarea>`)).join('')}
          ${editable ? '<button class="primary">Save call notes</button>' : ''}</form>
        <form data-pane="2" class="panel" hidden id="kyc-f">${kycForm(k, editable || can('kyc.verify'))}</form>
        <div data-pane="3" class="panel" hidden><h2>Conversion checklist</h2><ul class="checklist">
          ${[['kyc', 'KYC verified'], ['package', 'Package selected (subjects, hours, price)'], ['payment', 'Payment received or instalment plan approved'], ['amount', 'Sale amount recorded']].map(([key, label]) =>
    `<li><span class="${key === 'kyc' ? (ck.kyc ? 'ok' : 'no') : 'muted'}">${key === 'kyc' ? (ck.kyc ? 'Done' : 'Missing') : 'At convert'}</span> ${label}</li>`).join('')}</ul>
          <p class="small muted">Converting creates the student record, invoice, a 24-hour “assign teacher” task for Admin, Day 7 and Day 30 check-ins and a welcome WhatsApp. You stay on as retention owner.</p>
          ${editable && !closed ? '<button class="primary" id="a-conv2">Convert to student</button>' : ''}</div>
        <div data-pane="4" hidden><div class="panel flush" style="margin-bottom:16px">${taskTable(x.tasks)}</div>
          <div class="panel flush"><div style="padding:14px 16px 0"><h2>Follow-up history</h2></div>${x.followUps.length ? `<table><thead><tr><th>Due</th><th>Type</th><th>Status</th><th>Done</th></tr></thead><tbody>
            ${x.followUps.map((f) => `<tr><td>${dt(f.due_at)}</td><td>${esc(f.type || '')}</td><td>${pill(f.status === 'Done' ? (f.on_time ? 'On time' : 'Late') : f.status)}</td><td>${dt(f.done_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No follow-ups yet.</div>'}</div></div>
      </div>
      <div><div class="panel"><div class="panel-head"><h2>Timeline</h2></div>
        ${editable ? '<form id="note-f" style="margin-bottom:10px"><textarea name="text" placeholder="Add a note" style="min-height:50px"></textarea><button style="margin-top:6px">Add note</button></form>' : ''}
        ${timeline(x.activities)}</div></div></div>
      ${actionBar(l.phone, l.is_whatsapp, editable ? 'a-call-m' : null)}`);

    $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
      $$('.tabs button').forEach((x2) => x2.classList.toggle('on', x2 === b));
      $$('[data-pane]').forEach((p2) => { p2.hidden = p2.dataset.pane !== b.dataset.tab; });
    }));
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    on('#a-call', () => callModal(l));
    on('#a-call-m', () => callModal(l));
    on('#a-wa', () => waModal(l));
    on('#a-stage', () => stageModal(l));
    on('#a-fu', () => modal({ title: 'Set follow-up', body: followUpFields(localInput(l.next_follow_up_at) || inHours(2), l.next_follow_up_type || 'call'),
      onSubmit: async (f) => { await post(`/leads/${l.id}/follow-up`, { at: f.follow_up_at, type: f.follow_up_type }); toast('Follow-up saved'); reload(); } }));
    on('#a-reopen', () => stageModal(l, 'Contacted'));
    on('#a-conv', () => convertModal(l, ck));
    on('#a-conv2', () => convertModal(l, ck));
    on('#a-re', () => modal({ title: 'Reassign lead', body: field('New owner', select('owner_id', salesUsers().filter(([uid]) => uid !== l.owner_id), '', 'Choose rep', 'required')) + field('Reason', input('reason', 'Manager reassignment')),
      onSubmit: async (f) => { await post(`/leads/${l.id}/reassign`, f); toast('Lead reassigned'); reload(); } }));
    on('#a-edit', () => editLeadModal(l));
    on('#a-int', () => interactionModal(l));
    on('#a-ex', () => modal({ title: 'Exempt from 30-day reassignment', submit: 'Exempt',
      body: `${field('Days', input('days', '7', 'number', 'min="1" max="60"'))}${field('Reason *', input('reason', '', 'text', 'required placeholder="e.g. parent travelling, decision after exams"'))}`,
      onSubmit: async (f) => { await post(`/leads/${l.id}/exempt`, f); toast('Exemption saved'); reload(); } }));
    on('#a-arch', () => modal({ title: 'Archive lead', submit: 'Archive', body: `<p class="small muted">Nothing is deleted. The lead leaves every list but its full history stays on record.</p>${field('Reason *', input('reason', '', 'text', 'required'))}`,
      onSubmit: async (f) => { await post(`/leads/${l.id}/archive`, f); toast('Lead archived'); location.hash = '#/leads'; } }));
    on('#a-restore', async () => { await post(`/leads/${l.id}/restore`); toast('Lead restored'); reload(); });
    on('#a-merge', () => modal({ title: `Merge ${l.code} into another lead`, submit: 'Merge',
      body: `<p class="small muted">All calls, notes, tasks and follow-ups move to the lead you keep. This lead is archived and points to it.</p>
        ${x.duplicates.filter((dd) => !dd.archived).length ? field('Keep this lead', select('into_id', x.duplicates.filter((dd) => !dd.archived).map((dd) => [dd.id, `${dd.code} – ${dd.parent_name} (${dd.stage})`]))) : field('Lead ID to keep (e.g. 12)', input('into_id', '', 'number', 'required'))}`,
      onSubmit: async (f) => { const r = await post(`/leads/${l.id}/merge`, f); toast('Leads merged'); location.hash = `#/leads/${r.id}`; } }));
    bindTimeline(x.activities, (aid) => callModal(l, aid));
    const comp = qs().complete; if (comp && x.activities.some((a) => String(a.id) === comp && a.needs_note)) callModal(l, Number(comp));
    const nf = $('#notes-f'); if (nf) nf.onsubmit = async (e) => { e.preventDefault(); await api('PUT', `/leads/${l.id}/call-notes`, formData(nf)); toast('Call notes saved'); reload(); };
    const nt = $('#note-f'); if (nt) nt.onsubmit = async (e) => { e.preventDefault(); const f = formData(nt); if (!f.text) return; await post(`/leads/${l.id}/note`, f); reload(); };
    bindKyc(l, k);
    bindTaskTable();
  }

  function editLeadModal(l) {
    modal({
      title: 'Edit lead', wide: true,
      body: `<div class="grid3">${field('Parent name', input('parent_name', l.parent_name))}${field('Phone', input('phone', l.phone))}${field('Email', input('email', l.email))}</div>
        <div class="grid3">${field('Country', select('country', ['UAE', 'India'], l.country))}${field('City / Emirate', input('city', l.city))}${field('Score', select('score', ['Hot', 'Warm', 'Cold'], l.score))}</div>
        <div class="grid3">${field('Child name', input('child_name', l.child_name))}${field('Grade', input('grade', l.grade))}${field('Board', select('board', S.meta.boards, l.board, '—'))}</div>
        <div class="grid3">${field('Subjects', input('subjects', l.subjects))}${field('Campaign', input('campaign', l.campaign))}${field('Ad set', input('ad_set', l.ad_set))}</div>
        <label class="check"><input type="checkbox" name="is_whatsapp" ${l.is_whatsapp ? 'checked' : ''}> Phone is on WhatsApp</label>
        ${l.flagged ? '<label class="check"><input type="checkbox" name="unflag"> Clear the flag (number corrected)</label>' : ''}`,
      onSubmit: async (f) => { if (f.unflag) f.flagged = 0; delete f.unflag; await api('PATCH', `/leads/${l.id}`, f); toast('Lead updated'); reload(); },
    });
  }

  // Objection tags + sentiment + direction (blueprint 5.2), shared by every interaction form.
  const convoFields = () => `<div class="grid2">${field('Direction', select('direction', [['outbound', 'Outbound'], ['inbound', 'Inbound']], 'outbound'))}
      ${field('Parent sentiment', select('sentiment', S.meta.sentiments, 'Neutral', '—'))}</div>
    <label>Objections</label><div class="chips-pick">${S.meta.objections.map((o) => `<label class="check"><input type="checkbox" data-multi="1" name="objections" value="${esc(o)}"> ${esc(o)}</label>`).join('')}</div>`;

  function callModal(l, trackedId) {
    const tracked = trackedId ? true : false;
    modal({
      title: tracked ? `Add notes – tracked call with ${l.parent_name}` : `Log call – ${l.parent_name}`, submit: tracked ? 'Save notes' : 'Log call',
      body: `${tracked ? '<div class="callout green">The phone tracker already recorded this call\'s time and duration. Add what happened.</div>' : ''}
        ${field('Outcome *', select('outcome', tracked ? S.meta.callOutcomes.filter((o) => o.startsWith('Connected')) : S.meta.callOutcomes, '', 'Choose outcome', 'required id="oc"'))}
        <div id="oc-interested" hidden>${field('Move to', select('stage', ['Contacted', 'Qualified'], l.stage === 'Qualified' ? 'Qualified' : 'Contacted'))}</div>
        <div id="oc-lost" hidden><div class="grid2">${field('Move to', select('move_to', ['Lost', 'Nurture'], 'Lost'))}${field('Lost reason', select('lost_reason', S.meta.lostReasons, '', 'Choose reason'))}</div>
          <div class="small muted" style="margin-top:-6px;margin-bottom:10px">For Nurture, set the revisit date below.</div></div>
        <div id="oc-auto" class="callout" hidden></div>
        <div id="oc-conn" hidden>
          ${field('What was said *', `<textarea name="notes" id="oc-notes" placeholder="At least 2 lines: what the parent said, the child's problem, what you agreed"></textarea>`)}
          <div class="small muted" id="oc-count" style="margin:-8px 0 10px"></div>
          ${convoFields()}
          ${field('Next step', input('next_step', '', 'text', 'placeholder="e.g. Send demo slots on WhatsApp, call Thursday 6pm"'))}
        </div>
        <div id="oc-fu" hidden>${followUpFields(inHours(24))}</div>
        <div class="grid2" id="oc-dur">${tracked ? '' : field('Duration (min)', input('duration_min', '', 'number', 'min="0"'))}<div></div></div>`,
      onOpen: (form) => {
        const oc = $('#oc', form);
        const notes = $('#oc-notes', form);
        const count = () => {
          const lines = notes.value.split('\n').filter((x) => x.trim()).length;
          $('#oc-count', form).textContent = lines >= 2 || notes.value.trim().length >= S.meta.minNoteChars ? 'Looks complete' : `${lines} of 2 lines · ${notes.value.trim().length}/${S.meta.minNoteChars} characters`;
        };
        notes.oninput = count; count();
        oc.onchange = () => {
          const v = oc.value;
          const connected = v.startsWith('Connected');
          $('#oc-interested', form).hidden = v !== 'Connected - Interested';
          $('#oc-fu', form).hidden = !connected;
          $('#oc-conn', form).hidden = !connected;
          $('#oc-lost', form).hidden = v !== 'Connected - Not interested';
          const auto = { 'Not answered': `Stage → Attempted, WhatsApp task created${l.attempt_count === 0 ? '' : ' if due'}, retry scheduled automatically.`, Busy: 'Retry scheduled in 3 hours (same day).', 'Switched off': 'Retry scheduled in 3 hours (same day).', 'Wrong number': 'Lead is flagged for manager review.' }[v];
          $('#oc-auto', form).hidden = !auto; $('#oc-auto', form).textContent = `${auto || ''} Attempt ${l.attempt_count + 1} of 6.`;
          $$('#oc-fu input, #oc-fu select, #oc-interested select, #oc-lost select, #oc-conn input, #oc-conn select, #oc-conn textarea', form).forEach((el) => { el.disabled = el.closest('[hidden]') !== null; });
        };
        oc.onchange();
      },
      onSubmit: async (f) => {
        if (trackedId) f.activity_id = trackedId;
        const r = await post(`/leads/${l.id}/call`, f);
        const pts = can('game.view') && !trackedId ? 1 + (String(f.outcome).startsWith('Connected') ? 2 : 0) : 0;
        toast(`${trackedId ? 'Notes saved' : 'Call logged'} · ${r.stage}${pts ? ` · +${pts} pts` : ''}`);
        location.hash = `#/leads/${l.id}`; reload();
      },
    });
  }

  function interactionModal(l) {
    modal({
      title: `Log interaction – ${l.parent_name}`, submit: 'Log', wide: true,
      body: `<div class="grid2">${field('Type', select('type', [['demo', 'Demo class'], ['email', 'Email'], ['walkin', 'Walk-in visit']], 'demo', undefined, 'id="it"'))}
        <div id="it-demo">${field('Demo outcome', select('demo_outcome', ['Demo done', 'Demo no-show', 'Demo rescheduled'], 'Demo done'))}</div></div>
        ${field('What happened *', '<textarea name="summary" placeholder="At least 2 lines"></textarea>')}
        ${convoFields()}
        ${field('Next step *', input('next_step', '', 'text', 'required placeholder="e.g. Share package options, call after dinner"'))}
        ${followUpFields(inHours(24))}`,
      onOpen: (form) => { const it = $('#it', form); it.onchange = () => { $('#it-demo', form).hidden = it.value !== 'demo'; }; },
      onSubmit: async (f) => { const r = await post(`/leads/${l.id}/interaction`, f); toast(`Logged · ${r.stage}`); reload(); },
    });
  }

  function waModal(l) {
    const templates = ['Intro + brochure', 'Demo confirmation', 'Payment reminder', 'Follow-up nudge', 'Manual'];
    modal({
      title: `Log WhatsApp – ${l.parent_name}`, submit: 'Log message',
      body: `${field('Template', select('template', templates, 'Intro + brochure'))}${field('Message / note', '<textarea name="message"></textarea>')}
        <label class="check"><input type="checkbox" name="replied"> Parent replied</label>
        ${convoFields()}
        ${field('Screenshot / attachment link', input('attachment', '', 'url', 'placeholder="https://…"'))}
        <label class="check"><input type="checkbox" id="wa-fu-t"> Also set the next follow-up</label><div id="wa-fu" hidden>${followUpFields(inHours(24), 'call')}</div>`,
      onOpen: (form) => { const t = $('#wa-fu-t', form); const sync = () => { $('#wa-fu', form).hidden = !t.checked; $$('#wa-fu input, #wa-fu select', form).forEach((el) => { el.disabled = !t.checked; }); }; t.onchange = sync; sync(); },
      onSubmit: async (f) => { await post(`/leads/${l.id}/whatsapp`, f); toast('WhatsApp logged'); reload(); },
    });
  }

  function stageModal(l, preset) {
    const stages = S.meta.leadStages.filter((s) => s !== 'Converted' && s !== l.stage);
    modal({
      title: 'Change stage', submit: 'Save stage',
      body: `${field('New stage', select('stage', stages, preset || '', 'Choose stage', 'required id="st"'))}
        <div id="st-lost" hidden>${field('Lost reason *', select('lost_reason', S.meta.lostReasons, '', 'Choose reason'))}</div>
        <div id="st-demo" hidden>${field('Demo date & time *', `<input name="demo_at" type="datetime-local" value="${inHours(48)}">`)}</div>
        <div id="st-fu">${followUpFields(inHours(24))}<p class="small muted" style="margin-top:-6px">Every open lead must keep a next follow-up.</p></div>`,
      onOpen: (form) => {
        const st = $('#st', form);
        st.onchange = () => {
          const v = st.value;
          $('#st-lost', form).hidden = v !== 'Lost'; $('#st-fu', form).hidden = v === 'Lost'; $('#st-demo', form).hidden = v !== 'Demo Scheduled';
          $$('#st-lost select, #st-fu input, #st-fu select, #st-demo input', form).forEach((el) => { el.disabled = el.closest('[hidden]') !== null; });
          if (v === 'Demo Scheduled') form.follow_up_type.value = 'demo';
          if (v === 'Payment Pending') form.follow_up_type.value = 'payment';
        };
        st.onchange();
      },
      onSubmit: async (f) => { await post(`/leads/${l.id}/stage`, f); toast(`Stage → ${f.stage}`); reload(); },
    });
  }

  function convertModal(l, ck) {
    const isMgr = ['owner', 'sales_manager'].includes(role());
    modal({
      title: `Convert ${l.parent_name}`, submit: 'Convert to student', wide: true,
      body: `${ck.kyc ? '<div class="callout green">KYC verified.</div>' : '<div class="callout red">KYC is not verified yet. Complete the KYC tab and ask Admin to verify before converting.</div>'}
        <h3>Package</h3><div class="grid3">${field('Subjects *', input('subjects', l.subjects))}
        ${field('Hours *', `<select name="hours_pick" id="hp">${opts(S.meta.packages.map((h) => [h, `${h} hours`]).concat([['custom', 'Custom']]), 15)}</select>`)}
        ${field(`Price (${l.currency}) *`, input('price', '', 'number', 'min="0" step="0.01" required'))}</div>
        <div id="hc" hidden>${field('Custom hours', input('hours_custom', '', 'number', 'min="1"'))}</div>
        <h3>Payment</h3><div class="grid2"><label class="check"><input type="radio" name="pay_mode" value="full" checked> Payment received</label><label class="check"><input type="radio" name="pay_mode" value="plan"> Instalment plan</label></div>
        <div id="pm-full" class="grid3">${field('Amount received *', input('pay_amount', '', 'number', 'min="0" step="0.01"'))}${field('Method *', select('pay_method', ['Bank transfer', 'Card', 'Cash', 'UPI', 'Payment link', 'Cheque'], 'Bank transfer'))}${field('Reference *', input('pay_reference'))}</div>
        <div id="pm-plan" hidden><p class="small muted">Optionally record a first payment above, then list the remaining instalments.</p>
          ${[1, 2, 3].map((i) => `<div class="grid2">${field(`Instalment ${i} amount`, input(`ins_amount_${i}`, '', 'number', 'min="0"'))}${field('Due date', input(`ins_due_${i}`, '', 'date'))}</div>`).join('')}
          ${isMgr ? '<label class="check"><input type="checkbox" name="instalment_approved"> I approve this instalment plan (manager)</label>' : '<div class="callout">A Sales Manager must approve instalment plans.</div>'}</div>`,
      onOpen: (form) => {
        $('#hp', form).onchange = () => { $('#hc', form).hidden = $('#hp', form).value !== 'custom'; };
        $$('[name=pay_mode]', form).forEach((r) => { r.onchange = () => { $('#pm-plan', form).hidden = form.pay_mode.value !== 'plan'; }; });
        form.price.oninput = () => { if (!form.pay_amount.dataset.touched) form.pay_amount.value = form.price.value; };
        form.pay_amount.oninput = () => { form.pay_amount.dataset.touched = 1; };
      },
      onSubmit: async (f) => {
        const hours = f.hours_pick === 'custom' ? Number(f.hours_custom) : Number(f.hours_pick);
        const body = { subjects: f.subjects, hours, price: Number(f.price) };
        if (f.pay_amount && f.pay_reference) body.payment = { amount: Number(f.pay_amount), method: f.pay_method, reference: f.pay_reference };
        if (f.pay_mode === 'plan') {
          body.instalments = [1, 2, 3].filter((i) => Number(f[`ins_amount_${i}`]) > 0).map((i) => ({ amount: Number(f[`ins_amount_${i}`]), due_date: f[`ins_due_${i}`] }));
          body.instalment_approved = !!f.instalment_approved;
        }
        const r = await post(`/leads/${l.id}/convert`, body);
        toast('Converted – student created and Admin notified');
        if (can('game.view')) celebrate(body.price, l.currency);
        location.hash = `#/students/${r.student_id}`;
      },
    });
  }

  function kycForm(k, editable) {
    const locked = k.status === 'Verified' && !can('kyc.verify');
    const dis = !editable || locked ? 'disabled' : '';
    const f = (name, label, type = 'text') => field(label, `<input name="${name}" type="${type}" value="${esc(k[name] || '')}" ${dis}>`);
    return `<div class="panel-head"><h2>KYC ${pill(k.status)}</h2>${k.verified_at ? `<span class="small muted">Verified ${dt(k.verified_at)}</span>` : ''}</div>
      ${k.status === 'Rejected' ? `<div class="callout red">Rejected: ${esc(k.reject_reason)}. Fix and resubmit.</div>` : ''}
      <div class="grid2">${f('parent_full_name', 'Parent full name *')}${field('Relationship to child *', `<select name="relationship" ${dis}>${opts(['Mother', 'Father', 'Guardian'], k.relationship, '—')}</select>`)}</div>
      <div class="grid3">${field('ID type *', `<select name="id_type" ${dis}>${opts(['Emirates ID', 'Passport', 'Aadhaar'], k.id_type, '—')}</select>`)}${f('id_number', 'ID number *')}${f('id_file', 'ID upload (file link) *')}</div>
      <div class="grid2">${f('whatsapp', 'WhatsApp number')}${f('address', 'Address / emirate')}</div>
      <div class="grid3">${f('child_full_name', 'Child full name *')}${f('child_dob', 'Child date of birth *', 'date')}${f('school_name', 'School name *')}</div>
      <div class="grid2">${f('occupation', 'Parent occupation')}${f('enrollment_file', 'Signed enrollment form (file link) *')}</div>
      <label class="check"><input type="checkbox" name="consent_terms" ${k.consent_terms ? 'checked' : ''} ${dis}> Accepts terms & conditions</label>
      <label class="check"><input type="checkbox" name="consent_recording" ${k.consent_recording ? 'checked' : ''} ${dis}> Consents to class recording</label>
      <label class="check"><input type="checkbox" name="consent_data" ${k.consent_data ? 'checked' : ''} ${dis}> Consents to data use</label>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">${editable && !locked ? '<button type="submit" name="act" value="save">Save</button><button type="submit" class="primary" name="act" value="submit">Submit for verification</button>' : ''}
      ${can('kyc.verify') && k.status === 'Submitted' ? '<button type="button" class="primary" id="kyc-ok">Verify KYC</button><button type="button" class="danger" id="kyc-no">Reject</button>' : ''}</div>`;
  }

  function bindKyc(l) {
    const form = $('#kyc-f'); if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(form); f.submit = e.submitter?.value === 'submit';
      try { await api('PUT', `/leads/${l.id}/kyc`, f); toast(f.submit ? 'KYC submitted to Admin' : 'KYC saved'); reload(); } catch (err) { toast(err.message, true); }
    };
    const ok = $('#kyc-ok'); if (ok) ok.onclick = async () => { await post(`/leads/${l.id}/kyc/verify`, { approve: true }); toast('KYC verified'); reload(); };
    const no = $('#kyc-no'); if (no) no.onclick = () => modal({ title: 'Reject KYC', body: field('Reason', input('reason', '', 'text', 'required')),
      onSubmit: async (f) => { await post(`/leads/${l.id}/kyc/verify`, { approve: false, reason: f.reason }); toast('KYC rejected'); reload(); } });
  }

  // ---------------- leaderboard (sales gamification) ----------------
  const initials = (n) => String(n || '?').replace(/[–-].*$/, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const shortName = (n) => String(n || '').replace(/\s*[–-].*$/, '');
  const avatar = (n, cls = '') => `<span class="avatar ${cls}" aria-hidden="true">${esc(initials(n))}</span>`;
  const move = (m, hadPrev = true) => (!hadPrev ? '<span class="mv new">new</span>' : m > 0 ? `<span class="mv up" title="Up ${m}">▲ ${m}</span>` : m < 0 ? `<span class="mv down" title="Down ${-m}">▼ ${-m}</span>` : '<span class="mv same">–</span>');
  const progress = (val, goal, label, pace) => {
    const pct = goal ? Math.min(100, Math.round((val / goal) * 100)) : 0;
    return `<div class="goal"><div class="goal-top"><span>${label}</span><b class="num">${pct}%</b></div>
      <div class="goal-track">${pace !== undefined ? `<i class="pace" style="left:${pace}%" title="Where we should be today"></i>` : ''}<span style="width:${pct}%"></span></div></div>`;
  };
  let BADGE_INFO = null;

  function standingLine(m, rows) {
    if (!m.onBoard) return '';
    if (m.rank === 1) {
      const second = rows.find((r) => r.rank === 2);
      return second ? `You're leading by <b>${m.points - second.points} pts</b> over ${esc(shortName(second.name))}. Keep it.` : "You're leading.";
    }
    return m.next ? `<b>${m.next.gap} pts</b> to pass ${esc(shortName(m.next.name))} for #${m.next.rank}` : '';
  }

  async function dashGameCard() {
    try {
      const [m, b] = await Promise.all([get('/game/me'), get('/game/leaderboard?period=month')]);
      const top = b.rows.slice(0, 5);
      return `<a class="game-card" href="#/leaderboard">
        <div class="gc-me">${m.onBoard ? `<div class="gc-rank num">#${m.rank}<small>of ${m.of}</small></div>
          <div><div class="gc-line">${standingLine(m, b.rows)}</div>
          <div class="small gc-sub">${m.points} pts this month${m.streak ? ` · ${m.streak}-day streak` : ''} · ${m.callsToday}/${m.dailyCallTarget} calls today</div></div>`
    : '<div><div class="gc-line"><b>Sales leaderboard</b></div><div class="small gc-sub">See who is leading this month</div></div>'}</div>
        <ol class="gc-top">${top.map((r) => `<li class="${r.user_id === S.me.id ? 'me' : ''}"><span class="num">${r.rank}</span>${avatar(r.name, 'sm')}<span class="nm">${esc(shortName(r.name))}</span><b class="num">${r.points}</b></li>`).join('')}</ol>
      </a>`;
    } catch { return ''; }
  }

  async function pageLeaderboard() {
    const p = qs();
    const period = p.period || 'month';
    const market = p.market || '';
    const [b, m, goal, feed, rules] = await Promise.all([
      get(`/game/leaderboard?period=${period}${market ? `&market=${market}` : ''}`), get('/game/me'), get('/game/team-goal'), get('/game/feed?limit=12'),
      BADGE_INFO ? Promise.resolve(BADGE_INFO) : get('/game/rules'),
    ]);
    BADGE_INFO = rules;
    const badgeName = Object.fromEntries(rules.badges.map((x) => [x.id, x.name]));
    const by = p.by === 'revenue' ? 'revenue' : 'points';
    // Blueprint 15: reps ranked by revenue with deals and average deal; points view rewards the whole process.
    const rows = by === 'revenue'
      ? [...b.rows].sort((x, y) => y.revenueAED - x.revenueAED || y.conversions - x.conversions).map((r, i) => ({ ...r, rank: i + 1, movement: 0, prevRank: null, points: r.revenueAED }))
      : b.rows;
    const podium = [rows[1], rows[0], rows[2]].filter(Boolean);
    const periodLabel = { today: 'today', week: 'this week', month: 'this month' }[period];
    const qsFor = (o) => `#/leaderboard?${new URLSearchParams({ period, ...(market && { market }), ...o })}`;

    setPage(`<div class="page-head"><div><h1>Leaderboard</h1><div class="muted">Points from logged calls, demos, conversions and renewals</div></div>
      <div class="actions"><button id="how">How points work</button>${can('game.settings') ? '<button id="targets">Set targets</button>' : ''}</div></div>

      ${m.onBoard ? `<section class="panel standing" aria-label="Your standing">
        <div class="st-rank"><span class="num">#${m.rank}</span><small>of ${m.of} this month ${move(m.movement)}</small></div>
        <div class="st-main"><div class="st-line">${standingLine(m, (period === 'month' && !market) ? rows : (await get('/game/leaderboard?period=month')).rows)}</div>
          <div class="st-stats"><span><b class="num">${m.points}</b> pts</span><span>${m.streak ? `<b class="num">${m.streak}</b>-day streak` : 'No streak yet'}</span><span>Best month <b class="num">${m.personalBest}</b></span>${m.weekRank ? `<span>#<b class="num">${m.weekRank}</b> this week</span>` : ''}</div>
          ${progress(m.callsToday, m.dailyCallTarget, `Today's calls <span class="num">${m.callsToday} / ${m.dailyCallTarget}</span>${m.callsToday >= m.dailyCallTarget ? ' – target hit' : ` – ${m.dailyCallTarget - m.callsToday} to keep the streak`}`)}
          ${m.personalBest ? progress(m.points, m.personalBest, `Personal best <span class="num">${m.points} / ${m.personalBest}</span>${m.points > m.personalBest ? ' – new record' : ''}`) : ''}
        </div></section>` : ''}

      <section class="panel team-goal" aria-label="Team goal">
        <div class="panel-head"><h2>Team goal · ${esc(new Date(goal.month + '-01').toLocaleDateString('en-GB', { month: 'long' }))}</h2><span class="small muted desk-note">The marker shows where we should be today</span></div>
        <div class="tg-grid">${progress(goal.conversions, goal.conversionGoal, `New students <span class="num">${goal.conversions} / ${goal.conversionGoal}</span>`, goal.monthPct)}
        ${progress(goal.revenueAED, goal.revenueGoalAED, `Revenue <span class="num">AED ${goal.revenueAED.toLocaleString()} / ${goal.revenueGoalAED.toLocaleString()}</span>`, goal.monthPct)}</div>
      </section>

      <nav class="views">${[['points', 'Points'], ['revenue', 'Revenue']].map(([v, l]) => `<a href="${qsFor({ by: v })}" class="${v === by ? 'on' : ''}">${l}</a>`).join('')}<span style="flex:0 0 18px"></span>
        ${[['today', 'Today'], ['week', 'This week'], ['month', 'This month']].map(([v, l]) => `<a href="${qsFor({ period: v, by })}" class="${v === period ? 'on' : ''}">${l}</a>`).join('')}
        <span style="flex:1"></span>${[['', 'All'], ['UAE', 'UAE'], ['India', 'India']].map(([v, l]) => `<a href="#/leaderboard?${new URLSearchParams({ period, ...(v && { market: v }) })}" class="${v === market ? 'on' : ''}">${l}</a>`).join('')}</nav>

      ${rows.length ? `<div class="podium" aria-label="Top three">${podium.map((r) => `<div class="pod pod-${r.rank} ${r.user_id === S.me.id ? 'me' : ''}">
          ${avatar(r.name, 'lg')}<div class="pod-name">${esc(shortName(r.name))}</div><div class="pod-pts num">${by === 'revenue' ? `AED ${r.points.toLocaleString()}` : `${r.points} pts`}</div>
          <div class="pod-step"><span class="num">${r.rank}</span></div></div>`).join('')}</div>` : ''}
      ${b.mostImproved ? `<div class="callout green">Most improved ${periodLabel}: <b>${esc(shortName(b.mostImproved.name))}</b>, up ${b.mostImproved.gain} pts on the previous period.</div>` : ''}

      <div class="table-wrap"><table class="board-table"><thead><tr><th>Rep</th><th class="r">${by === 'revenue' ? 'Revenue (AED)' : 'Points'}</th><th>Move</th><th class="r">Deals</th><th class="r">${by === 'revenue' ? 'Avg deal (AED)' : 'Revenue (AED)'}</th><th class="r">Calls</th><th class="r">Connect</th><th class="r">Streak</th><th>Badges</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="${r.user_id === S.me.id ? 'me' : ''}"><td><span class="rk num">${r.rank}</span>${avatar(r.name, 'sm')}<b>${esc(shortName(r.name))}</b>${r.user_id === S.me.id ? ' <span class="pill green">You</span>' : ''}<div class="small muted">${esc(r.market || 'Manager')}</div></td>
          <td class="r num"><b>${r.points.toLocaleString()}</b></td><td>${move(r.movement, r.prevRank !== null)}</td><td class="r num">${r.conversions + r.renewals}</td>
          <td class="r num">${by === 'revenue' ? ((r.conversions + r.renewals) ? Math.round(r.revenueAED / (r.conversions + r.renewals)).toLocaleString() : '—') : r.revenueAED.toLocaleString()}</td>
          <td class="r num">${r.calls}</td><td class="r num">${r.connectRate === null ? '—' : `${r.connectRate}%`}</td><td class="r num">${r.streak ? `${r.streak}d` : '—'}</td>
          <td>${r.badges.map((x) => `<span class="badge-chip">${esc(badgeName[x] || x)}</span>`).join(' ') || '<span class="muted">—</span>'}</td></tr>`).join('')}
      </tbody></table></div>

      <div class="lb-grid">
        <section class="panel"><div class="panel-head"><h2>Team wins</h2><span class="small muted">Last 14 days</span></div>
          ${feed.length ? `<ul class="wins">${feed.map((w) => `<li>${avatar(w.name, 'sm')}<div class="w-body"><div><b>${esc(shortName(w.name))}</b> ${w.kind === 'conversion' ? `enrolled <b>${esc(w.child_name || 'a student')}</b> · ${w.hours} hrs` : w.kind === 'renewal' ? `renewed <b>${esc(w.child_name)}</b> · ${w.hours} hrs` : `booked a demo for <b>${esc(w.child_name || w.parent_name)}</b>`}</div>
            <div class="small muted">${ago(w.at)} · +${w.points} pts</div></div>
            ${w.mine ? `<span class="kudos-count small muted">${w.kudos ? `${w.kudos} kudos` : ''}</span>` : `<button class="small kudos ${w.gave ? 'given' : ''}" data-k="${w.kind}" data-ref="${w.ref_id}" ${w.gave ? 'disabled' : ''}>${w.gave ? 'Kudos sent' : 'Give kudos'}${w.kudos ? ` · ${w.kudos}` : ''}</button>`}</li>`).join('')}</ul>`
    : '<div class="empty">No wins yet in the last two weeks. The first conversion shows up here.</div>'}</section>
        ${m.onBoard ? `<section class="panel"><div class="panel-head"><h2>Your badges</h2><span class="small muted">${m.badges.filter((x) => x.earned).length} of ${m.badges.length}</span></div>
          <ul class="badges">${m.badges.map((x) => `<li class="${x.earned ? 'earned' : ''}"><div class="bd-name">${esc(x.name)}</div><div class="small muted">${esc(x.desc)}</div>
            ${x.earned ? '<div class="small bd-done">Earned</div>' : `<div class="bd-track"><span style="width:${Math.round((x.progress / x.need) * 100)}%"></span></div><div class="small muted num">${x.progress} / ${x.need}</div>`}</li>`).join('')}</ul></section>` : ''}
      </div>`);

    $$('.kudos[data-k]').forEach((btn) => { btn.onclick = async () => {
      try { await post('/game/kudos', { kind: btn.dataset.k, ref_id: Number(btn.dataset.ref) }); btn.textContent = 'Kudos sent'; btn.disabled = true; btn.classList.add('given'); toast('Kudos sent – they get +2 pts'); } catch (e) { toast(e.message, true); }
    }; });
    $('#how').onclick = () => {
      const pt = rules.points;
      modal({ title: 'How points work', body: `<dl class="fields">
        <dt>Call logged</dt><dd>${pt.call} pt (max ${rules.maxCallsPerLeadPerDay} per lead per day)</dd><dt>Parent picked up</dt><dd>+${pt.connected} pts</dd>
        <dt>WhatsApp reply</dt><dd>${pt.whatsappReply} pt</dd><dt>First call within 15 min</dt><dd>${pt.fastFirstCall} pts</dd>
        <dt>Demo booked</dt><dd>${pt.demo} pts</dd><dt>New student</dt><dd>${pt.conversion} pts + 1 per AED 100 of the sale</dd>
        <dt>Renewal</dt><dd>${pt.renewal} pts + 1 per AED 200</dd><dt>Kudos received</dt><dd>${pt.kudosReceived} pts</dd></dl>
        <p class="small muted" style="margin-top:14px">INR sales count at the AED rate, so UAE and India compete fairly. Streaks count working days where you hit the daily call target; weekends don't break them.</p>
        <h3 style="margin-top:16px">Badges</h3><dl class="fields">${rules.badges.map((x) => `<dt>${esc(x.name)}</dt><dd>${esc(x.desc)}</dd>`).join('')}</dl>` });
    };
    const t = $('#targets'); if (t) t.onclick = async () => {
      const cur = await get('/game/settings');
      modal({ title: 'Team targets', submit: 'Save targets',
        body: `${field('Daily call target per rep (streaks)', input('dailyCallTarget', cur.dailyCallTarget, 'number', 'min="1"'))}
          ${field('Monthly new-student goal (team)', input('monthlyConversionGoal', cur.monthlyConversionGoal, 'number', 'min="1"'))}
          ${field('Monthly revenue goal, AED (team)', input('monthlyRevenueGoalAED', cur.monthlyRevenueGoalAED, 'number', 'min="1"'))}`,
        onSubmit: async (f) => { await api('PUT', '/game/settings', f); toast('Targets saved'); reload(); } });
    };
  }

  // One celebratory moment when a rep converts a lead.
  async function celebrate(price, currency) {
    try {
      const m = await get('/game/me');
      const aed = currency === 'INR' ? price / S.meta.exchangeRate.INR_PER_AED : price;
      const pts = BADGE_INFO?.points ? BADGE_INFO.points.conversion + Math.floor(aed / 100) : 50 + Math.floor(aed / 100);
      const root = document.createElement('div');
      root.className = 'celebrate';
      root.innerHTML = `<div class="cel-card" role="status"><div class="cel-pts num">+${pts}</div><div class="cel-title">New student enrolled</div>
        <div class="small">You're <b>#${m.rank}</b> this month with ${m.points} pts${m.next ? ` · ${m.next.gap} to pass ${esc(shortName(m.next.name))}` : ''}</div></div>`;
      document.body.appendChild(root);
      setTimeout(() => root.remove(), 3600);
      root.onclick = () => root.remove();
    } catch { /* not on the board */ }
  }

  // ---------------- scorecards (blueprint 16.2) ----------------
  const fmtMetric = (m) => (m.value === null ? '—' : m.unit === '%' ? `${m.value}%` : m.unit === 'AED' ? `AED ${Number(m.value).toLocaleString()}` : m.value);
  const scoreTiles = (metrics) => `<div class="score-grid">${metrics.map((m) => `<div class="score ${m.ok === false ? 'bad' : m.ok ? 'good' : ''}">
    <div class="v">${esc(fmtMetric(m))}</div><div>${esc(m.label)}</div>${m.target !== null ? `<div class="t">Target ${m.unit === '%' ? `${m.target}%` : m.higherIsBetter === false || m.target === 0 ? (m.target === 0 ? '0' : `≤ ${m.target}`) : m.target}</div>` : ''}</div>`).join('')}</div>`;

  async function pageScorecard() {
    const p = qs();
    const period = p.period || 'week';
    const mine = await get(`/scorecard?period=${period}${p.user ? `&user=${p.user}` : ''}`);
    const team = can('audit.view') && !p.user ? await get(`/scorecards/team?period=${period}`) : [];
    const below = mine.metrics.filter((m) => m.ok === false);
    setPage(`<div class="page-head"><div><h1>${p.user ? esc(mine.user.name) : 'My scorecard'}</h1><div class="muted">${esc(S.meta.roles[mine.user.role])} · ${d(mine.from)} – ${d(new Date(new Date(mine.to) - 1).toISOString())}</div></div></div>
      <nav class="views">${[['today', 'Today'], ['week', 'This week'], ['month', 'This month']].map(([v, l]) => `<a href="#/scorecard?${new URLSearchParams({ period: v, ...(p.user && { user: p.user }) })}" class="${v === period ? 'on' : ''}">${l}</a>`).join('')}</nav>
      ${below.length ? `<div class="callout red">Below target: ${below.map((m) => esc(m.label)).join(', ')}. Two weeks below target on notes or on-time follow-ups starts a coaching session.</div>` : mine.metrics.some((m) => m.ok) ? '<div class="callout green">On target for this period.</div>' : ''}
      ${scoreTiles(mine.metrics)}
      ${team.length ? `<h2 style="margin-top:24px">Team scorecards</h2><div class="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Below target</th><th>Key numbers</th></tr></thead><tbody>
        ${team.map((c) => `<tr class="click" data-href="#/scorecard?period=${period}&user=${c.user.id}"><td><a href="#/scorecard?period=${period}&user=${c.user.id}"><b>${esc(c.user.name)}</b></a></td><td>${esc(S.meta.roles[c.user.role])}</td>
          <td>${c.metrics.filter((m) => m.ok === false).map((m) => pill(m.label).replace('pill ', 'pill red ')).join(' ') || '<span class="pill green">All on target</span>'}</td>
          <td class="small">${c.metrics.slice(0, 4).map((m) => `${esc(m.label)}: <b>${esc(fmtMetric(m))}</b>`).join(' · ')}</td></tr>`).join('')}</tbody></table></div>` : ''}`);
    $$('tr.click').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.tagName !== 'A') location.hash = tr.dataset.href; }));
  }

  // ---------------- weekly review (blueprint 16.7) ----------------
  async function pageReview() {
    const p = qs();
    const tab = p.tab || 'review';
    const head = `<div class="page-head"><div><h1>Weekly review</h1><div class="muted">30 minutes, CRM data only – leave with action items that have owners and dates</div></div>
      <div class="actions"><button class="primary" id="new-action">Add action item</button></div></div>
      <nav class="views">${[['review', 'Review'], ['edits', 'Note edits to approve'], ['audit', 'Audit log']].map(([v, l]) => `<a href="#/review?tab=${v}" class="${v === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>`;
    if (tab === 'edits') {
      const rows = await get('/edit-requests');
      setPage(`${head}<div class="table-wrap">${rows.length ? `<table><thead><tr><th>Requested</th><th>By</th><th>Original</th><th>Change to</th><th>Reason</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${dt(r.created_at)}<div class="small"><a href="#/${r.entity === 'lead' ? 'leads' : 'students'}/${r.entity_id}">Open record</a></div></td><td>${esc(r.requested_by_name)}</td>
          <td class="small" style="white-space:pre-wrap">${esc(r.old_body)}</td><td class="small" style="white-space:pre-wrap">${esc(r.new_body)}</td><td>${esc(r.reason)}</td>
          <td class="r" style="white-space:nowrap"><button class="small primary" data-er="${r.id}" data-d="approve">Approve</button> <button class="small danger" data-er="${r.id}" data-d="reject">Reject</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No edits waiting. Staff can edit their own notes for 24 hours; later changes come here.</div>'}</div>`);
      $$('[data-er]').forEach((b) => { b.onclick = async () => { await post(`/edit-requests/${b.dataset.er}/${b.dataset.d}`); toast(b.dataset.d === 'approve' ? 'Edit approved – old version kept' : 'Edit rejected'); reload(); }; });
    } else if (tab === 'audit') {
      const rows = await get(`/audit?${new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([k, v]) => v && k !== 'tab')))}`);
      setPage(`${head}<form class="filters" id="af"><input type="hidden" name="tab" value="audit">
        ${select('entity', ['leads', 'students', 'payments', 'payouts', 'teachers', 'users', 'kyc', 'classes', 'activities', 'settings', 'packages'], p.entity, 'Any record type')}
        ${select('user_id', S.meta.users.map((u) => [u.id, u.name]), p.user_id, 'Anyone')}${select('action', ['create', 'update', 'archive', 'merge', 'import', 'export', 'login', 'edit_approved', 'edit_rejected', '2fa_enabled', '2fa_reset'], p.action, 'Any action')}
        <input type="date" name="from" value="${esc(p.from || '')}"><input type="date" name="to" value="${esc(p.to || '')}"><button>Filter</button></form>
        <p class="small muted">Every change records who, what, when and old → new values. Nothing is hard-deleted. Only managers and the Owner can see this.</p>
        <div class="table-wrap">${rows.length ? `<table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Changes</th></tr></thead><tbody>
        ${rows.map((a) => `<tr><td class="small">${dt(a.created_at)}</td><td>${esc(a.user_name || 'System')}</td><td>${esc(a.action)}</td>
          <td>${esc(a.entity)}${a.entity_id ? ` #${a.entity_id}` : ''}</td>
          <td class="small">${a.changes ? Object.entries(a.changes).slice(0, 6).map(([k, [o, n]]) => `<b>${esc(k)}</b>: ${esc(String(o ?? '—').slice(0, 40))} → ${esc(String(n ?? '—').slice(0, 40))}`).join('<br>') : esc(a.note || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No matching entries.</div>'}</div>`);
      $('#af').onsubmit = (e) => { e.preventDefault(); location.hash = `#/review?${new URLSearchParams(Object.entries(formData(e.target)).filter(([, v]) => v))}`; };
    } else {
      const r = await get('/review');
      const list = (rows, fn, empty) => (rows.length ? `<ul class="plain">${rows.map(fn).join('')}</ul>` : `<div class="muted small">${empty}</div>`);
      setPage(`${head}
        <div class="kpis">${kpi(r.pipeline.newThisWeek, 'New leads this week')}${kpi(r.pipeline.convertedThisWeek, 'Converted this week')}${kpi(r.overdue.length, 'Overdue follow-ups', r.overdue.length > 0)}
          ${kpi(r.escalationsOpen.length, 'Open escalations', r.escalationsOpen.length > 0)}${kpi(r.renewals.due, 'Students due for renewal')}${kpi(r.renewals.doneLastWeek, 'Renewals last week')}
          ${kpi(r.mismatches.length, 'Payout mismatches', r.mismatches.length > 0)}${kpi(r.tickets.length, 'Open teacher/student issues', r.tickets.length > 0)}</div>
        <div class="dash-grid">
          <section class="panel"><h2>Compliance below target</h2>${list(r.compliance, (c) => `<li><a href="#/scorecard?user=${c.user.id}"><b>${esc(c.user.name)}</b></a> – ${c.below.map((m) => `${esc(m.label)} ${esc(fmtMetric(m))}`).join(', ')}</li>`, 'Everyone is on target this week.')}</section>
          <section class="panel"><h2>Coaching</h2>${list(r.coaching, (c) => `<li><b>${esc(c.user_name)}</b> ${pill(c.status)} <span class="small muted">${esc(c.reason)}</span>${c.status === 'Due' ? ` <button class="small" data-coach="${c.id}">Log session</button>` : `<div class="small muted">${esc(c.notes || '')}</div>`}</li>`, 'No coaching due.')}</section>
          <section class="panel"><h2>Formal review triggers</h2>${list(r.triggers, (t) => `<li><b>${esc(t.user.name)}</b>: ${t.reasons.map(esc).join('; ')}</li>`, 'No repeated breaches in the last two weeks.')}
            <p class="small muted">Apply the consequences agreed in writing with staff.</p></section>
          <section class="panel"><h2>Escalated (overdue 48h)</h2>${list(r.escalationsOpen, (e) => `<li><a href="#/leads/${e.entity_id}">${esc(e.parent_name || e.code)}</a> – ${esc(e.owner_name || '')} <span class="small muted">${ago(e.created_at)}</span> <button class="small" data-esc="${e.id}">Resolve</button></li>`, 'Nothing escalated.')}</section>
          <section class="panel"><h2>Lost reasons (last week)</h2>${barList(Object.fromEntries(r.lost.map((x) => [x.lost_reason || '—', x.n])))}</section>
          <section class="panel"><h2>Teacher / student issues</h2>${list(r.tickets, (t) => `<li>${esc(t.title)} <span class="small muted">due ${dt(t.due_at)}</span></li>`, 'No open tickets.')}</section>
          <section class="panel"><h2>Payout accuracy</h2>${list(r.mismatches, (m) => `<li>${esc(m.name)}: attendance ${m.attendance_hours} h vs payout ${m.payout_hours} h</li>`, 'Payout hours match attendance.')}</section>
          <section class="panel"><h2>Pipeline now</h2>${barList(Object.fromEntries(Object.entries(r.pipeline.byStage).filter(([k]) => !['Converted', 'Lost'].includes(k))))}</section>
        </div>
        <h2 style="margin-top:22px">Overdue list</h2><div class="table-wrap">${r.overdue.length ? `<table><thead><tr><th>Lead</th><th>Owner</th><th>Due</th><th>Type</th></tr></thead><tbody>${r.overdue.map((o) => `<tr><td><a href="#/leads/${o.id}">${esc(o.parent_name)}</a> <span class="small muted">${esc(o.code)}</span>${o.escalated ? ' ' + pill('Escalated').replace('pill ', 'pill red ') : ''}</td><td>${esc(o.owner_name || '—')}</td><td>${dueCell(o.next_follow_up_at)}</td><td>${esc(o.next_follow_up_type || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing overdue.</div>'}</div>
        <h2 style="margin-top:22px">Action items</h2><div class="table-wrap">${taskTable(r.actions, true)}</div>`);
      bindTaskTable();
      $$('[data-coach]').forEach((b) => { b.onclick = () => modal({ title: 'Log coaching session', submit: 'Save', body: field('What was discussed and agreed *', '<textarea name="notes" required></textarea>'),
        onSubmit: async (f) => { await post(`/coaching/${b.dataset.coach}/held`, f); toast('Coaching session logged'); reload(); } }); });
      $$('[data-esc]').forEach((b) => { b.onclick = () => modal({ title: 'Resolve escalation', submit: 'Resolve', body: field('What was done', input('note', '', 'text', 'placeholder="Took over / reassigned / called the parent"')),
        onSubmit: async (f) => { await post(`/escalations/${b.dataset.esc}/resolve`, f); toast('Escalation resolved'); reload(); } }); });
    }
    $('#new-action').onclick = () => modal({ title: 'Add action item', submit: 'Add',
      body: `${field('Action *', input('title', '', 'text', 'required'))}<div class="grid2">${field('Owner', select('assignee_id', users().map((u) => [u.id, u.name]), S.me.id))}${field('Due', `<input type="datetime-local" name="due_at" value="${inHours(72)}">`)}</div>`,
      onSubmit: async (f) => { await post('/tasks', { ...f, type: 'review' }); toast('Action item added'); reload(); } });
  }

  // ---------------- phone tracker (blueprint 6) ----------------
  async function pagePhone() {
    const all = can('leads.reassign');
    const [mine, everyone] = await Promise.all([get('/devices'), all ? get('/devices?all=1') : Promise.resolve([])]);
    const devTable = (rows, showUser) => (rows.length ? `<table><thead><tr>${showUser ? '<th>Rep</th>' : ''}<th>Phone</th><th>Status</th><th>Last sync</th><th class="r">Calls sent</th><th></th></tr></thead><tbody>
      ${rows.map((d) => `<tr>${showUser ? `<td>${esc(d.user_name)}</td>` : ''}<td>${esc(d.name || 'Phone')}</td><td>${d.revoked ? pill('Revoked') : d.pending ? pill('Waiting for pairing') : '<span class="pill green">Paired</span>'}</td>
        <td>${d.last_seen ? ago(d.last_seen) : '—'}</td><td class="r num">${d.events}</td><td class="r">${!d.revoked && !d.pending ? `<button class="small danger" data-rv="${d.id}">Revoke</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No phones paired yet.</div>');
    setPage(`<div class="page-head"><div><h1>Phone tracker</h1><div class="muted">Dials and talk time measured from the company phone, not typed in</div></div>
      <div class="actions"><button class="primary" id="pair">Create pairing code</button></div></div>
      <div class="panel"><h2>How it works</h2><ol class="small" style="padding-left:18px;line-height:1.8;margin:0">
        <li>Install the Jeta Call Tracker app on your <b>company Android phone</b> (your admin sends the APK).</li>
        <li>Tap <b>Create pairing code</b> here and type the 6-digit code into the app within 10 minutes.</li>
        <li>Calls with CRM parents are matched automatically. Personal calls never leave the phone.</li>
        <li>After a connected call you get an alert: open the lead and <b>Add notes</b> within 10 minutes.</li></ol>
        <p class="small muted" style="margin-bottom:0">iPhones can't share the call log. Use a cloud telephony provider instead – it sends calls to the CRM the same way.</p></div>
      <h2>My phones</h2><div class="table-wrap" style="margin-bottom:20px">${devTable(mine, false)}</div>
      ${all ? `<h2>All team phones</h2><div class="table-wrap">${devTable(everyone, true)}</div>` : ''}`);
    $('#pair').onclick = async () => {
      const r = await post('/devices/pairing', { name: 'Company phone' });
      modal({ title: 'Pair your phone', body: `<p>Open the Jeta Call Tracker app and enter:</p><div class="pair-code">${esc(r.code)}</div>
        <p class="small muted">CRM address: <b>${esc(location.origin)}</b><br>The code expires at ${new Date(r.expires_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.</p>` });
    };
    $$('[data-rv]').forEach((b) => { b.onclick = async () => { if (!confirm('Revoke this phone? It stops sending calls immediately.')) return; await post(`/devices/${b.dataset.rv}/revoke`); toast('Phone revoked'); reload(); }; });
  }

  // ---------------- settings (Owner) ----------------
  async function pageSettings() {
    const st = await get('/settings');
    const c = st.company; const T = st.compliance;
    setPage(`<div class="page-head"><div><h1>Settings</h1><div class="muted">Changes are recorded in the audit log</div></div></div>
      <div class="dash-grid">
      <form class="panel" data-key="company"><h2>Company &amp; invoices</h2>
        ${field('Brand name', input('name', c.name))}${field('Legal name', input('legal_name', c.legal_name))}
        ${field('Address', `<textarea name="address">${esc(c.address)}</textarea>`)}
        <div class="grid2">${field('TRN (VAT number)', input('trn', c.trn))}${field('Invoice prefix', input('invoice_prefix', c.invoice_prefix))}</div>
        <div class="grid2">${field('Phone', input('phone', c.phone))}${field('Email', input('email', c.email, 'email'))}</div>
        ${field('Website', input('website', c.website))}${field('Logo URL', input('logo_url', c.logo_url))}
        <label class="check"><input type="checkbox" name="vat_enabled" ${c.vat_enabled ? 'checked' : ''}> Charge VAT (prices include VAT)</label>
        ${field('VAT rate %', input('vat_rate', c.vat_rate, 'number', 'min="0" max="30" step="0.5"'))}
        ${field('Invoice footer', `<textarea name="footer">${esc(c.footer)}</textarea>`)}
        <p class="small muted">Invoices are numbered ${esc(c.invoice_prefix)}-${new Date().getFullYear()}-0001 and restart each year.</p><button class="primary">Save company details</button></form>
      <div>
        <form class="panel" data-key="assignment"><h2>Lead assignment</h2>
          ${field('New leads go to', select('mode', [['round_robin', 'Round-robin within the market'], ['least_open', 'Rep with the fewest open leads']], st.assignment.mode))}<button class="primary">Save</button></form>
        <form class="panel" data-key="escalation"><h2>Escalation at +48 hours</h2>
          ${field('When a follow-up is 48 hours overdue', select('hours48Action', [['flag', 'Flag red – manager takes over'], ['reassign', 'Reassign to the next rep automatically']], st.escalation.hours48Action))}<button class="primary">Save</button></form>
        <form class="panel" data-key="payouts"><h2>Teacher payouts</h2>
          ${field('Payout cycle', select('cycle', [['monthly', 'Monthly'], ['fortnightly', 'Fortnightly (1–15, 16–end)']], st.payouts.cycle))}<button class="primary">Save</button></form>
        <form class="panel" data-key="security"><h2>Security</h2>
          ${field('Two-step sign-in for Owner, Admin and Accounts', select('require2fa', [['', 'Automatic (on for real servers, off for demo data)'], ['true', 'Always on'], ['false', 'Off']], st.security.require2fa === null ? '' : String(st.security.require2fa)))}
          <button class="primary">Save</button></form>
      </div>
      <form class="panel" data-key="compliance"><h2>Scorecard targets</h2>
        <div class="grid2">${field('Notes completed %', input('notesPct', T.notesPct, 'number'))}${field('Follow-ups on time %', input('onTimeFollowUpPct', T.onTimeFollowUpPct, 'number'))}</div>
        <div class="grid2">${field('First-call SLA %', input('firstCallSlaPct', T.firstCallSlaPct, 'number'))}${field('Teacher assigned in 24h %', input('teacherAssign24hPct', T.teacherAssign24hPct, 'number'))}</div>
        <div class="grid2">${field('Exceptions cleared in 24h %', input('exceptionsCleared24hPct', T.exceptionsCleared24hPct, 'number'))}${field('KYC verified in 24h %', input('kycVerified24hPct', T.kycVerified24hPct, 'number'))}</div>
        <div class="grid2">${field('Invoices in 24h %', input('invoices24hPct', T.invoices24hPct, 'number'))}${field('Payouts on time %', input('payoutsOnTimePct', T.payoutsOnTimePct, 'number'))}</div>
        ${field('Payouts due (days after period end)', input('payoutDueDays', T.payoutDueDays, 'number'))}
        <p class="small muted">Agree targets and consequences with staff in writing before launch. Two weeks below the notes or on-time target starts a coaching session.</p><button class="primary">Save targets</button></form>
      <div class="panel"><h2>Integrations</h2><dl class="fields">
        <dt>Google Workspace</dt><dd>${S.meta.google ? '<span class="pill green">Connected</span> Meet links and attendance are automatic' : '<span class="pill">Not set up</span> Admin pastes Meet links; attendance via teacher form + Meet CSV import'}</dd>
        <dt>WhatsApp / email</dt><dd>Configured on the server (see DEPLOY.md)</dd>
        <dt>Phone tracker</dt><dd><a href="#/phone">Manage phones</a></dd></dl></div>
      </div>`);
    $$('form[data-key]').forEach((f) => { f.onsubmit = async (e) => {
      e.preventDefault();
      const body = formData(f);
      if (f.dataset.key === 'security') body.require2fa = body.require2fa === '' || body.require2fa === undefined ? null : body.require2fa === 'true';
      try { await api('PUT', `/settings/${f.dataset.key}`, body); S.settings = await get('/settings'); toast('Saved'); } catch (err) { toast(err.message, true); }
    }; });
  }

  // ---------------- tasks ----------------
  function taskTable(tasks, showLink = false) {
    if (!tasks.length) return '<div class="empty">No tasks.</div>';
    return `<table><thead><tr><th>Task</th><th>Type</th><th>Due</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>
      ${tasks.map((t) => `<tr><td>${showLink && t.entity ? `<a href="#/${t.entity === 'lead' ? 'leads' : 'students'}/${t.entity_id}">${esc(t.title)}</a>` : esc(t.title)}</td><td>${esc(t.type || '')}</td>
        <td>${t.status === 'Open' ? dueCell(t.due_at) : dt(t.done_at)}</td><td>${t.priority === 'High' ? pill('High') : 'Normal'}</td><td>${pill(t.status)}</td>
        <td class="r">${t.status === 'Open' ? `<button class="small" data-done="${t.id}">Mark done</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  }
  function bindTaskTable() {
    $$('[data-done]').forEach((b) => { b.onclick = async () => { await post(`/tasks/${b.dataset.done}/done`); toast('Task done'); reload(); }; });
  }
  async function pageTasks() {
    const p = qs();
    const scope = p.scope || 'mine';
    const tasks = await get(`/tasks?scope=${scope}&status=${p.status || 'Open'}`);
    setPage(`<div class="page-head"><div><h1>${scope === 'all' ? 'All tasks' : 'My tasks'}</h1><div class="muted">${tasks.length} ${esc((p.status || 'Open').toLowerCase())}</div></div>
      <div class="actions"><button class="primary" id="nt">New task</button></div></div>
      <nav class="views"><a href="#/tasks" class="${scope === 'mine' && !p.status ? 'on' : ''}">My open</a>${can('dashboard.team') ? `<a href="#/tasks?scope=all" class="${scope === 'all' && !p.status ? 'on' : ''}">Team open</a>` : ''}<a href="#/tasks?status=Done" class="${p.status === 'Done' ? 'on' : ''}">Done</a></nav>
      <div class="table-wrap">${taskTable(tasks, true)}</div>`);
    bindTaskTable();
    $('#nt').onclick = () => modal({ title: 'New task', body: `${field('Title', input('title', '', 'text', 'required'))}<div class="grid2">${field('Type', select('type', ['call', 'whatsapp', 'demo', 'payment', 'ticket'], 'call'))}${field('Due', `<input type="datetime-local" name="due_at" value="${inHours(4)}">`)}</div>
      <div class="grid2">${field('Assign to', select('assignee_id', users().map((u) => [u.id, u.name]), S.me.id))}${field('Priority', select('priority', ['Normal', 'High'], 'Normal'))}</div>`,
    onSubmit: async (f) => { await post('/tasks', f); toast('Task created'); reload(); } });
  }

  // ---------------- students ----------------
  const meter = (s) => {
    const used = s.total_hours ? Math.min(100, (s.hours_used / s.total_hours) * 100) : 0;
    return `<div class="meter"><div class="track" role="meter" aria-valuemin="0" aria-valuemax="${s.total_hours}" aria-valuenow="${s.hours_used}" aria-label="Hours used"><span class="used ${hoursClass(s)}" style="width:${used}%"></span></div>
      <div class="cap"><span><b>${+(s.total_hours - s.hours_used).toFixed(2)}</b> hrs remaining</span><span>${s.hours_used} of ${s.total_hours} used</span></div></div>`;
  };
  const miniMeter = (s) => `<span class="mini-meter"><i class="${hoursClass(s)}" style="width:${s.total_hours ? Math.min(100, (s.hours_used / s.total_hours) * 100) : 0}%"></i></span><span class="num small">${s.hours_remaining} left</span>`;

  async function pageStudents() {
    const p = qs();
    const view = p.view || 'all';
    const rows = await get(`/students?${new URLSearchParams(p)}`);
    setPage(`<div class="page-head"><div><h1>Students</h1><div class="muted">${rows.length} shown${role() === 'sales_exec' ? ' · students you own for retention' : ''}</div></div>
      ${can('exports') ? '<div class="actions"><button id="exp">Export CSV</button></div>' : ''}</div>
      <nav class="views">${[['all', 'All'], ['unassigned', 'Awaiting teacher'], ['renewal', 'Due for renewal']].map(([v, l]) => `<a href="#/students?view=${v}" class="${v === view ? 'on' : ''}">${l}</a>`).join('')}</nav>
      <form class="filters" id="sf"><input type="hidden" name="view" value="${esc(view)}"><input name="search" placeholder="Child, parent, ID" value="${esc(p.search || '')}">
        ${select('stage', S.meta.studentStages, p.stage, 'Any stage')}${select('retention', S.meta.retentionStages, p.retention, 'Any retention stage')}
        ${select('teacher', S.meta.teachers.map((t) => [t.id, t.name]), p.teacher, 'Any teacher')}${select('country', ['UAE', 'India'], p.country, 'Any market')}<button>Filter</button></form>
      <div class="table-wrap">${rows.length ? `<table class="student-table"><thead><tr><th>Student</th><th>Subjects</th><th>Stage</th><th>Retention</th><th>Teacher</th><th>Hours</th><th>Owners</th><th>Last action</th></tr></thead><tbody>
        ${rows.map((s) => `<tr class="click" data-href="#/students/${s.id}"><td><a href="#/students/${s.id}"><b>${esc(s.child_name)}</b></a><div class="small muted">${esc(s.code)} · ${esc(s.parent_name)}</div></td>
          <td>${esc(s.subjects || '')}<div class="small muted">${esc([s.grade && `Gr ${s.grade}`, s.board, s.country].filter(Boolean).join(' · '))}</div></td>
          <td>${pill(s.stage)}</td><td>${pill(s.retention_stage) || '<span class="muted">—</span>'}</td><td>${esc(s.teacher_name || '—')}${s.batch_name ? `<div class="small muted">${esc(s.batch_name)}</div>` : ''}</td>
          <td>${miniMeter(s)}</td><td class="small">Admin: ${esc(s.admin_owner_name || '—')}<div>Retention: ${esc(s.retention_owner_name || '—')}</div></td>
          <td class="small ${s.last_action_at && (Date.now() - new Date(s.last_action_at)) > 7 * 864e5 && !['Churned', 'Completed'].includes(s.stage) ? 'due-over' : ''}">${ago(s.last_action_at || s.joined_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No students here yet. Students appear when a lead is converted.</div>'}</div>`);
    $('#sf').onsubmit = (e) => { e.preventDefault(); location.hash = `#/students?${new URLSearchParams(Object.entries(formData(e.target)).filter(([, v]) => v))}`; };
    $('#exp') && ($('#exp').onclick = () => openDoc('/export/students.csv', 'students.csv'));
    $$('tr.click').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.tagName !== 'A') location.hash = tr.dataset.href; }));
  }

  function classRows(classes, { mark = false } = {}) {
    if (!classes.length) return '<div class="empty">No classes yet.</div>';
    return `<table><thead><tr><th>When</th><th>Student</th><th>Teacher</th><th>Subject</th><th class="r">Hrs</th><th>Status</th><th>Topic / remarks</th><th></th></tr></thead><tbody>
      ${classes.map((c) => {
        const past = new Date(c.scheduled_at) < new Date();
        const unmarked = c.status === 'Scheduled' && past;
        return `<tr><td class="${unmarked ? 'due-over' : ''}">${dt(c.scheduled_at)}${c.is_demo ? ' ' + pill('Demo') : ''}</td><td><a href="#/students/${c.student_id}">${esc(c.child_name || '')}</a></td><td>${esc(c.teacher_name)}</td><td>${esc(c.subject || '')}</td>
          <td class="r num">${c.duration_hours}</td><td>${unmarked ? pill('Unmarked') : pill(c.status)}</td><td class="small">${esc([c.topic, c.remarks, c.reschedule_reason].filter(Boolean).join(' – '))}</td>
          <td class="r">${mark && can('attendance.edit') ? `<button class="small" data-att="${c.id}" data-st="${esc(c.status)}">${c.status === 'Scheduled' ? 'Mark' : 'Edit'}</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
  }
  function bindAttendance(classes) {
    $$('[data-att]').forEach((b) => {
      b.onclick = () => {
        const c = classes.find((x) => String(x.id) === b.dataset.att);
        modal({
          title: `Attendance – ${dt(c.scheduled_at)}`, submit: 'Save attendance',
          body: `${field('Status', select('status', S.meta.attendanceStatuses, c.status === 'Scheduled' ? 'Completed' : c.status, undefined, 'id="as"'))}
            <div class="callout" id="as-pol"></div>${field('Topic covered', input('topic', c.topic))}${field('Remarks / reason', `<textarea name="remarks">${esc(c.remarks || '')}</textarea>`)}
            <div id="as-rs" hidden>${field('New date & time', '<input type="datetime-local" name="reschedule_to">')}${field('Reschedule reason', input('reschedule_reason'))}</div>`,
          onOpen: (form) => {
            const as = $('#as', form);
            as.onchange = () => {
              const pol = S.meta.attendancePolicy[as.value];
              $('#as-pol', form).textContent = `${pol.deductHours ? 'Deducts' : 'Does not deduct'} ${c.duration_hours} hr from the student · teacher ${pol.payTeacher ? 'is' : 'is not'} paid.`;
              const rs = ['Rescheduled', 'Student Absent (notice given)', 'Teacher Absent'].includes(as.value);
              $('#as-rs', form).hidden = !rs;
              $$('#as-rs input', form).forEach((el) => { el.disabled = !rs; });
            };
            as.onchange();
          },
          onSubmit: async (f) => { await post(`/classes/${c.id}/attendance`, f); toast('Attendance saved'); reload(); },
        });
      };
    });
  }

  async function pageStudent(id) {
    const x = await get(`/students/${id}`);
    const s = x.student;
    const admin = can('students.edit');
    const ret = can('retention.edit');
    const flow = ['Awaiting Teacher', 'Teacher Assigned', 'Scheduled', 'Active', 'Hours Low', 'Completed'];
    const ci = flow.indexOf(s.stage);
    setPage(`<a class="back" href="#/students">Back to students</a>
      <div class="record-head"><div class="row1"><div><h1>${esc(s.child_name)} ${pill(s.stage)} ${s.retention_stage ? pill(s.retention_stage) : ''}</h1>
        <div class="muted">${esc(s.code)} · Parent ${esc(s.parent_name)} · ${contactLinks(s.phone)} · ${esc(s.country)} (${esc(s.currency)})</div></div>
        <div class="record-actions">
          ${admin ? `<button class="primary" id="b-assign">${s.teacher_id ? 'Change teacher' : 'Assign teacher'}</button>${s.teacher_id ? '<button id="b-sched">Schedule classes</button><button id="b-class">Add class</button>' : ''}<button id="b-stage">Change stage</button>` : ''}
          ${ret ? '<button id="b-rlog">Log retention call</button><button id="b-rstage">Retention stage</button><button id="b-renew">Renew</button>' : ''}
          ${s.lead_id ? `<a class="btn" href="#/leads/${s.lead_id}">Open lead</a>` : ''}</div></div>
        <div class="meta"><span>Teacher <b>${esc(x.teacher?.name || 'Not assigned')}</b>${s.batch_type ? ` · ${esc(s.batch_type)}${s.batch_name ? ` ${esc(s.batch_name)}` : ''}` : ''}</span>
          <span>Schedule <b>${s.schedule_days ? `${esc(s.schedule_days)} at ${esc(s.schedule_time)} (${esc(s.timezone)})` : '—'}</b></span>
          <span>Subjects <b>${esc(s.subjects || '—')}</b></span><span>Admin owner <b>${esc(s.admin_owner_name || '—')}</b></span><span>Retention owner <b>${esc(s.retention_owner_name || '—')}</b></span><span>Joined <b>${d(s.joined_at)}</b></span>
          ${s.meet_link ? `<span>Class link <b><a href="${esc(s.meet_link)}" target="_blank" rel="noopener">Google Meet</a></b></span>` : ''}
          <span><button class="link small" id="b-ics">Calendar file</button></span></div>
        ${meter(s)}
        ${!['Churned', 'Paused', 'Renewed'].includes(s.stage) ? `<div class="stages">${flow.map((st, i) => `<span class="${st === s.stage ? 'cur' : ci > i ? 'done' : ''}">${esc(st)}</span>`).join('')}</div>` : ''}</div>
      ${x.blockers.length && !['Active', 'Churned', 'Completed'].includes(s.stage) ? `<div class="callout">Cannot go Active yet: ${esc(x.blockers.join(', '))}.</div>` : ''}
      ${s.stage === 'Churned' ? `<div class="callout red">Churned – ${esc(s.churn_reason)}</div>` : ''}
      <div class="record"><div>
        <div class="tabs">${['Classes', 'Packages & payments', 'Details', 'Tasks'].map((t, i) => `<button type="button" data-tab="${i}" class="${i === 0 ? 'on' : ''}">${t}</button>`).join('')}</div>
        <div data-pane="0" class="panel flush">${classRows(x.classes.map((c) => ({ ...c, child_name: s.child_name })), { mark: true })}</div>
        <div data-pane="1" hidden><div class="panel flush" style="margin-bottom:16px"><table><thead><tr><th>Package</th><th>Kind</th><th class="r">Hours</th><th class="r">Price</th><th>Sold</th></tr></thead><tbody>
          ${x.packages.map((p) => `<tr><td>${esc(p.subjects)}</td><td>${esc(p.kind)}</td><td class="r num">${p.hours}</td><td class="r num">${money(p.price, p.currency)}</td><td>${d(p.created_at)}</td></tr>`).join('')}</tbody></table></div>
          <div class="panel flush">${paymentTable(x.payments)}</div>
          ${can('payments.edit') ? '<button style="margin-top:10px" id="b-pay">Record payment / instalment</button>' : ''}</div>
        <div data-pane="2" class="panel" hidden><div class="panel-head"><h2>Details</h2>${admin ? '<button id="b-edit">Edit</button>' : ''}</div><dl class="fields">
          <dt>Child</dt><dd>${esc(s.child_name)}</dd><dt>Grade / Board</dt><dd>${esc(s.grade || '—')} / ${esc(s.board || '—')}</dd><dt>Parent</dt><dd>${esc(s.parent_name)}</dd>
          <dt>Phone</dt><dd>${esc(s.phone)}</dd><dt>Email</dt><dd>${esc(s.email || '—')}</dd><dt>City</dt><dd>${esc(s.city || '—')}</dd>
          <dt>KYC</dt><dd>${pill(x.kyc?.status || 'Pending')}</dd><dt>Start date</dt><dd>${esc(s.start_date || '—')}</dd><dt>Time zone</dt><dd>${esc(s.timezone || '—')}</dd></dl>
          <p class="small muted" style="margin-top:12px">Parent contact details are never shown on teacher-facing documents (anti-poaching).</p></div>
        <div data-pane="3" class="panel flush" hidden>${taskTable(x.tasks)}</div></div>
      <div><div class="panel"><h2>Timeline</h2><form id="note-f" style="margin-bottom:10px"><textarea name="text" placeholder="Add a note" style="min-height:50px"></textarea><button style="margin-top:6px">Add note</button></form>${timeline(x.activities)}</div></div></div>
      ${actionBar(s.phone, true, ret ? 'b-rlog-m' : null, 'Log retention')}`);

    $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
      $$('.tabs button').forEach((x2) => x2.classList.toggle('on', x2 === b));
      $$('[data-pane]').forEach((p2) => { p2.hidden = p2.dataset.pane !== b.dataset.tab; });
    }));
    bindAttendance(x.classes.map((c) => ({ ...c, child_name: s.child_name })));
    bindTaskTable(); bindPayments();
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    $('#note-f').onsubmit = async (e) => { e.preventDefault(); const f = formData(e.target); if (!f.text) return; await post(`/students/${s.id}/note`, f); reload(); };
    on('#b-assign', async () => {
      const ts = await get(`/students/${s.id}/eligible-teachers`);
      modal({
        title: 'Assign teacher', submit: 'Assign teacher', wide: true,
        body: `<p class="small muted">Filtered by subject, board and grade; best matches first. Max ${S.meta.maxBatchSize} per batch.</p>
          <div class="table-wrap" style="margin-bottom:14px"><table><thead><tr><th></th><th>Teacher</th><th>Subjects</th><th>Grades</th><th>Country</th><th>Availability</th><th class="r">Students</th></tr></thead><tbody>
          ${ts.map((t) => `<tr><td><input type="radio" name="teacher_id" value="${t.id}" ${t.id === s.teacher_id ? 'checked' : ''} aria-label="${esc(t.name)}"></td><td><b>${esc(t.name)}</b> ${t.match ? pill('Match') : ''}</td><td>${esc(t.subjects)}</td><td>${esc(t.grades)}</td>
            <td>${esc(t.country)}${t.matchCountry ? '' : ' <span class="small muted">(other market)</span>'}</td><td class="small">${esc(t.availability || '')}</td><td class="r num">${t.active_students}</td></tr>`).join('')}</tbody></table></div>
          <div class="grid3">${field('Batch type', select('batch_type', ['1:1', 'Batch'], s.batch_type || '1:1'))}${field('Batch name (if batch)', input('batch_name', s.batch_name))}${field('Start date', input('start_date', s.start_date || new Date().toISOString().slice(0, 10), 'date'))}</div>`,
        onSubmit: async (f) => { if (!f.teacher_id) throw new Error('Pick a teacher'); await post(`/students/${s.id}/assign-teacher`, f); toast('Teacher assigned'); reload(); },
      });
    });
    on('#b-ics', () => openDoc(`/students/${s.id}/schedule.ics`, `schedule-${s.code}.ics`));
    on('#b-sched', () => modal({
      title: 'Schedule classes', submit: 'Create classes',
      body: `<label>Days</label><div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((dd) => `<label class="check"><input type="checkbox" data-multi="1" name="days" value="${dd}" ${(s.schedule_days || '').includes(dd.toLowerCase()) ? 'checked' : ''}> ${dd}</label>`).join('')}</div>
        <div class="grid3">${field('Time', input('time', s.schedule_time || '17:00', 'time'))}${field('Time zone', select('timezone', [['Asia/Dubai', 'UAE (GST)'], ['Asia/Kolkata', 'India (IST)']], s.timezone))}${field('Hours per class', input('duration_hours', '1', 'number', 'min="0.5" step="0.5"'))}</div>
        ${S.meta.google ? '<p class="small muted">A Jeta-owned Google Meet link is created automatically and the teacher is invited.</p>' : field('Jeta Google Meet link (created under the Jeta account)', input('meet_link', s.meet_link || '', 'url', 'placeholder="https://meet.google.com/abc-defg-hij"'))}
        <div class="grid2">${field('Starting', input('start_date', new Date().toISOString().slice(0, 10), 'date'))}${field('Weeks ahead', input('weeks', '4', 'number', 'min="1" max="12"'))}</div>
        <p class="small muted">Classes stop at the hours remaining. Slots that clash with the teacher's other classes are skipped. Parent and teacher get WhatsApp reminders 24h and 1h before.</p>`,
      onSubmit: async (f) => { const r = await post(`/students/${s.id}/schedule`, f); toast(`${r.created} classes created${r.clashes.length ? `, ${r.clashes.length} skipped (clash)` : ''}`); reload(); },
    }));
    on('#b-class', () => modal({ title: 'Add a single class', submit: 'Add class',
      body: `<div class="grid2">${field('Date & time', `<input type="datetime-local" name="scheduled_at" value="${inHours(24)}" required>`)}${field('Hours', input('duration_hours', '1', 'number', 'min="0.5" step="0.5"'))}</div>${field('Subject', input('subject', s.subjects))}<label class="check"><input type="checkbox" name="is_demo"> Demo class (demo rate)</label>`,
      onSubmit: async (f) => { await post(`/students/${s.id}/classes`, f); toast('Class added'); reload(); } }));
    on('#b-stage', () => modal({ title: 'Change student stage', submit: 'Save stage',
      body: `${field('Stage', select('stage', S.meta.studentStages.filter((st) => st !== s.stage), '', 'Choose stage', 'required'))}${field('Reason (mandatory for Churned)', select('reason', S.meta.churnReasons, '', '—'))}`,
      onSubmit: async (f) => { await post(`/students/${s.id}/stage`, f); toast(`Stage → ${f.stage}`); reload(); } }));
    on('#b-rlog-m', () => $('#b-rlog').click());
    on('#b-rlog', () => modal({ title: 'Log retention call / WhatsApp', submit: 'Log',
      body: `<div class="grid2">${field('Channel', select('channel', [['call', 'Call'], ['whatsapp', 'WhatsApp']], 'call'))}${field('Outcome', select('outcome', ['Happy – will renew', 'Thinking', 'Has concerns', 'Not renewing', 'No answer', 'Check-in done'], '', 'Choose', 'required'))}</div>
        ${field('Parent feedback', '<textarea name="feedback"></textarea>')}${field('Issue for Admin (creates a ticket)', select('issue', ['Teacher', 'Timing', 'Results', 'Billing', 'Other'], '', 'No issue'))}
        ${field('Notes', '<textarea name="notes"></textarea>')}${field('Next follow-up', '<input type="datetime-local" name="follow_up_at">')}`,
      onSubmit: async (f) => { await post(`/students/${s.id}/retention-log`, f); toast('Logged'); reload(); } }));
    on('#b-rstage', () => modal({ title: 'Retention stage', submit: 'Save',
      body: `${field('Stage', select('stage', S.meta.retentionStages.filter((st) => st !== 'Renewed'), s.retention_stage, 'Choose'))}${field('Churn reason (if churned)', select('reason', S.meta.churnReasons, '', '—'))}`,
      onSubmit: async (f) => { await post(`/students/${s.id}/retention-stage`, f); toast('Retention stage saved'); reload(); } }));
    on('#b-renew', () => modal({ title: `Renew – ${s.child_name}`, submit: 'Record renewal',
      body: `<div class="grid3">${field('Subjects', input('subjects', s.subjects))}${field('Hours', select('hours', S.meta.packages.map((h) => [h, `${h} hours`]), 15))}${field(`Price (${s.currency})`, input('price', '', 'number', 'required min="0"'))}</div>
        <label class="check"><input type="checkbox" name="paid" id="rn-p" checked> Payment received now</label>
        <div id="rn-pay" class="grid3">${field('Amount', input('pay_amount', '', 'number'))}${field('Method', select('pay_method', ['Bank transfer', 'Card', 'Cash', 'UPI', 'Payment link'], 'Bank transfer'))}${field('Reference', input('pay_reference'))}</div>
        <div id="rn-due" hidden>${field('Payment due date', input('due_date', '', 'date'))}</div>`,
      onOpen: (form) => { const t = $('#rn-p', form); t.onchange = () => { $('#rn-pay', form).hidden = !t.checked; $('#rn-due', form).hidden = t.checked; }; form.price.oninput = () => { form.pay_amount.value = form.price.value; }; },
      onSubmit: async (f) => {
        const body = { subjects: f.subjects, hours: Number(f.hours), price: Number(f.price), due_date: f.due_date };
        if (f.paid) { if (!f.pay_reference) throw new Error('Payment reference is required'); body.payment = { amount: Number(f.pay_amount || f.price), method: f.pay_method, reference: f.pay_reference }; }
        await post(`/students/${s.id}/renew`, body); toast('Renewal recorded – hours added'); reload();
      } }));
    on('#b-edit', () => modal({ title: 'Edit student', body: `<div class="grid2">${field('Child name', input('child_name', s.child_name))}${field('Parent name', input('parent_name', s.parent_name))}</div>
      <div class="grid3">${field('Grade', input('grade', s.grade))}${field('Board', select('board', S.meta.boards, s.board, '—'))}${field('Subjects', input('subjects', s.subjects))}</div>
      <div class="grid2">${field('Email', input('email', s.email))}${field('City', input('city', s.city))}</div>
      ${field('Jeta Google Meet link', input('meet_link', s.meet_link || '', 'url', 'placeholder="https://meet.google.com/…"'))}`,
    onSubmit: async (f) => { await api('PATCH', `/students/${s.id}`, f); toast('Saved'); reload(); } }));
    on('#b-pay', () => modal({ title: 'Record payment or instalment', submit: 'Save',
      body: `<div class="grid2">${field(`Amount (${s.currency})`, input('amount', '', 'number', 'required'))}${field('Instalment no.', input('instalment_no', '2', 'number'))}</div>
        ${field('Package', select('package_id', x.packages.map((p) => [p.id, `${p.kind} · ${p.hours} hrs · ${d(p.created_at)}`]), x.packages[0]?.id))}
        <p class="small muted">Fill method and reference if the money is received; otherwise set a due date to create a pending instalment with reminders.</p>
        <div class="grid3">${field('Method', select('method', ['Bank transfer', 'Card', 'Cash', 'UPI', 'Payment link'], '', '—'))}${field('Reference', input('reference'))}${field('Due date', input('due_date', '', 'date'))}</div>`,
      onSubmit: async (f) => { await post('/payments', { ...f, student_id: s.id }); toast('Payment saved'); reload(); } }));
  }

  // ---------------- payments ----------------
  function paymentTable(rows, { student = false } = {}) {
    if (!rows.length) return '<div class="empty">No payments.</div>';
    return `<table><thead><tr><th>Invoice</th>${student ? '<th>Student</th>' : ''}<th class="r">Amount</th><th>Instalment</th><th>Due / paid</th><th>Method · ref</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((p) => {
        const over = p.status === 'Pending' && p.due_date && p.due_date < new Date().toISOString().slice(0, 10);
        const act = [];
        if (['Pending', 'Partial'].includes(p.status) && can('payments.edit')) act.push(`<button class="small" data-pay="${p.id}">Mark paid</button>`);
        if (['Paid', 'Partial'].includes(p.status)) act.push(`<button class="small" data-ref="request" data-id="${p.id}">Request refund</button>`);
        if (p.status === 'Refund Requested' && can('refunds.approve')) act.push(`<button class="small" data-ref="approve" data-id="${p.id}">Approve refund</button><button class="small danger" data-ref="reject" data-id="${p.id}">Reject</button>`);
        if (p.status === 'Refund Approved' && can('payments.approve')) act.push(`<button class="small" data-ref="process" data-id="${p.id}">Mark refunded</button>`);
        act.push(`<button class="small link" data-inv="${p.id}">Invoice</button>`);
        return `<tr><td>${esc(p.invoice_no)}</td>${student ? `<td><a href="#/students/${p.student_id}">${esc(p.child_name || '')}</a><div class="small muted">${esc(p.parent_name || '')}</div></td>` : ''}
          <td class="r num">${money(p.amount, p.currency)}</td><td>${p.instalment_no}${p.package_kind ? ` · ${esc(p.package_kind)}` : ''}</td>
          <td class="${over ? 'due-over' : ''}">${p.paid_at ? `Paid ${d(p.paid_at)}` : p.due_date ? `Due ${esc(p.due_date)}` : '—'}</td><td class="small">${esc([p.method, p.reference].filter(Boolean).join(' · ') || '—')}</td>
          <td>${pill(over ? 'Overdue' : p.status)}${p.refund_reason ? `<div class="small muted">${esc(p.refund_reason)}</div>` : ''}</td><td class="r" style="white-space:nowrap">${act.join(' ')}</td></tr>`;
      }).join('')}</tbody></table>`;
  }
  function bindPayments() {
    $$('[data-pay]').forEach((b) => { b.onclick = () => modal({ title: 'Mark payment received', submit: 'Mark paid',
      body: `<div class="grid2">${field('Method', select('method', ['Bank transfer', 'Card', 'Cash', 'UPI', 'Payment link', 'Cheque'], 'Bank transfer'))}${field('Reference', input('reference', '', 'text', 'required'))}</div>${field('Paid on', input('paid_at', new Date().toISOString().slice(0, 10), 'date'))}`,
      onSubmit: async (f) => { await post(`/payments/${b.dataset.pay}/pay`, { ...f, paid_at: f.paid_at ? new Date(f.paid_at).toISOString() : undefined }); toast('Payment recorded – receipt sent'); reload(); } }); });
    $$('[data-ref]').forEach((b) => { b.onclick = async () => {
      const action = b.dataset.ref;
      if (action === 'request') return modal({ title: 'Request refund', submit: 'Send for approval', body: field('Reason', '<textarea name="reason" required></textarea>'),
        onSubmit: async (f) => { await post(`/payments/${b.dataset.id}/refund/request`, f); toast('Refund sent to manager'); reload(); } });
      try { await post(`/payments/${b.dataset.id}/refund/${action}`); toast(`Refund ${action}d`); reload(); } catch (e) { toast(e.message, true); }
    }; });
    $$('[data-inv]').forEach((b) => { b.onclick = () => openDoc(`/payments/${b.dataset.inv}/invoice`); });
  }

  // ---------------- classes ----------------
  async function pageClasses() {
    const p = qs();
    const today = new Date().toISOString().slice(0, 10);
    const filter = p.filter || 'week';
    const range = filter === 'week' ? { from: today, to: new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10) }
      : filter === 'past' ? { from: new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10), to: today } : {};
    const params = new URLSearchParams({ ...range, ...(filter === 'unmarked' && { filter: 'unmarked' }), ...(p.teacher && { teacher: p.teacher }) });
    const rows = filter === 'review' ? await get('/classes/review') : await get(`/classes?${params}`);
    const adminTools = can('attendance.edit') ? '<button id="meet-imp">Import Meet attendance</button>' : '';
    setPage(`<div class="page-head"><div><h1>Classes & attendance</h1><div class="muted">${rows.length} ${filter === 'review' ? 'items need review' : 'classes'}</div></div><div class="actions">${adminTools}${can('exports') ? '<button id="exp">Export CSV</button>' : ''}</div></div>
      <nav class="views">${[['review', 'Needs review'], ['week', 'Next 7 days'], ['past', 'Last 14 days'], ['unmarked', 'Unmarked']].map(([v, l]) => `<a href="#/classes?filter=${v}" class="${v === filter ? 'on' : ''}">${l}</a>`).join('')}</nav>
      ${filter === 'review' ? `<p class="small muted">Attendance is marked from Google Meet (teacher + student at 80% of the slot) or the teacher's post-class form. Only exceptions land here: time mismatches over 10 minutes, absences, missing proof, random 10% audits, duplicates and classes unmarked for 48 hours.</p>
        <div class="table-wrap">${rows.length ? `<table><thead><tr><th>Class</th><th>Teacher</th><th>Why it's here</th><th>Meet / form</th><th>Status</th><th></th></tr></thead><tbody>
        ${rows.map((c) => `<tr><td>${dt(c.scheduled_at)}<div class="small"><a href="#/students/${c.student_id}">${esc(c.child_name)}</a> · ${esc(c.subject || '')}</div></td><td>${esc(c.teacher_name)}</td>
          <td><span class="pill amber">${esc(c.review_flag)}</span></td>
          <td class="small">${c.teacher_minutes !== null && c.teacher_minutes !== undefined ? `Meet: teacher ${Math.round(c.teacher_minutes)}m, student ${Math.round(c.student_minutes || 0)}m<br>` : ''}${c.teacher_confirmed_at ? `Form: ${Math.round((c.teacher_reported_hours || 0) * 60)} min${c.topic ? ` – ${esc(c.topic)}` : ''}<br>` : ''}${c.proof_link ? `<a href="${esc(c.proof_link)}" target="_blank" rel="noopener">Proof</a>` : ''}</td>
          <td>${pill(c.status)}</td><td class="r"><button class="small primary" data-rev="${c.id}">Review</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing to review. Attendance is up to date.</div>'}</div>` : ''}
      <form class="filters" id="cf"><input type="hidden" name="filter" value="${esc(filter)}">${select('teacher', S.meta.teachers.map((t) => [t.id, t.name]), p.teacher, 'All teachers')}<button>Filter</button></form>
      ${filter === 'unmarked' && rows.length ? '<div class="callout red">These classes are past but not marked. Hours and teacher payouts stay wrong until attendance is recorded.</div>' : ''}
      ${filter === 'review' ? '' : `<div class="table-wrap">${classRows(rows, { mark: true })}</div>`}`);
    if (filter !== 'review') bindAttendance(rows);
    $$('[data-rev]').forEach((b) => { b.onclick = () => {
      const c = rows.find((x) => String(x.id) === b.dataset.rev);
      modal({ title: `Review – ${c.child_name}, ${dt(c.scheduled_at)}`, submit: 'Save review',
        body: `<div class="callout">${esc(c.review_flag)}</div>
          ${field('Attendance status', select('status', S.meta.attendanceStatuses, c.status === 'Scheduled' ? '' : c.status, c.status === 'Scheduled' ? 'Keep unmarked' : 'Keep as is'))}
          ${field('Note', input('remarks', '', 'text', 'placeholder="What you checked"'))}
          <div class="grid2">${field('Reschedule to (if needed)', '<input type="datetime-local" name="reschedule_to">')}${field('Reschedule reason', input('reschedule_reason'))}</div>`,
        onSubmit: async (f) => { if (!f.status) delete f.status; await post(`/classes/${c.id}/review`, f); toast('Reviewed'); reload(); } });
    }; });
    $('#meet-imp') && ($('#meet-imp').onclick = () => modal({ title: 'Import Google Meet attendance', submit: 'Import', wide: true,
      body: `<p class="small muted">Use the Meet attendance report (CSV). Each row is one participant: <b>email</b> and <b>minutes</b> (or duration like 0:58:10), plus either <b>class_id</b>, or <b>meet_link</b> (or meet_code) and <b>date</b>. The teacher is matched by the email on their teacher profile.</p>
        ${field('CSV file', '<input type="file" accept=".csv,text/csv" id="meet-file" required>')}<div id="meet-prev" class="callout" hidden></div>`,
      onOpen: (form) => { $('#meet-file', form).onchange = async (e) => { const rows2 = parseCsv(await e.target.files[0].text());
        form.dataset.rows = JSON.stringify(rows2.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]+/g, '_'), v])))
          .map((r) => ({ class_id: r.class_id, meet_link: r.meet_link, meet_code: r.meet_code || r.meeting_code, date: r.date, email: r.email || r.participant_email, minutes: r.minutes || r.duration })));
        const pv = $('#meet-prev', form); pv.hidden = false; pv.textContent = `${rows2.length} rows ready`; }; },
      onSubmit: async (f, form) => { const records = JSON.parse(form.dataset.rows || '[]'); if (!records.length) throw new Error('Choose a CSV file');
        const r = await post('/classes/meet-attendance', { records }); toast(`${r.classes} classes matched, ${r.marked} updated${r.unmatched ? `, ${r.unmatched} rows unmatched` : ''}`); reload(); } }));
    $('#cf').onsubmit = (e) => { e.preventDefault(); location.hash = `#/classes?${new URLSearchParams(Object.entries(formData(e.target)).filter(([, v]) => v))}`; };
    $('#exp') && ($('#exp').onclick = () => openDoc('/export/classes.csv', 'classes.csv'));
  }

  // ---------------- teachers ----------------
  function teacherModal(t = {}) {
    modal({
      title: t.id ? `Edit ${t.name}` : 'New teacher', wide: true,
      body: `<div class="grid3">${field('Name *', input('name', t.name, 'text', 'required'))}${field('Country *', select('country', ['UAE', 'India'], t.country || 'UAE'))}${field('Status', select('status', ['Active', 'Inactive'], t.status || 'Active'))}</div>
        <div class="grid3">${field('Subjects (comma separated)', input('subjects', t.subjects))}${field('Grades', input('grades', t.grades, 'text', 'placeholder="6,7,8"'))}${field('Boards', input('boards', t.boards, 'text', 'placeholder="CBSE,ICSE"'))}</div>
        <div class="grid3">${field('Rate per hour', input('rate_per_hour', t.rate_per_hour, 'number', 'min="0" step="0.01"'))}${field('Demo class rate', input('demo_rate', t.demo_rate, 'number', 'min="0"'))}${field('Availability', input('availability', t.availability, 'text', 'placeholder="Mon–Fri 4–9pm"'))}</div>
        <div class="grid3">${field('Phone', input('phone', t.phone))}${field('Email', input('email', t.email, 'email'))}${field('Bank / UPI details', input('bank_details', t.bank_details))}</div>
        <p class="small muted">Payout currency follows country: UAE → AED, India → INR. Currencies are never mixed in one payout. Email must match the teacher's Google account for Meet attendance. Bank details are stored encrypted.</p>
        <h3 style="margin-top:14px">Rate rules (optional)</h3><p class="small muted">Leave blank fields to match anything. The most specific matching rule wins; otherwise the rate per hour above applies.</p>
        <div id="rates">${[0, 1, 2, 3].map((i) => `<div class="grid3" style="grid-template-columns:1fr 1fr 1fr 1fr">${field('Subject', input(`r_subject_${i}`, '', 'text', 'placeholder="Maths"'))}${field('Grade', input(`r_grade_${i}`, '', 'text', 'placeholder="12"'))}
          ${field('Batch', select(`r_batch_${i}`, [['1:1', '1:1'], ['Batch', 'Batch']], '', 'Any'))}${field('Rate', input(`r_rate_${i}`, '', 'number', 'min="0" step="0.01"'))}</div>`).join('')}</div>`,
      onOpen: async (form) => {
        if (!t.id) return;
        const rules = await get(`/teachers/${t.id}/rates`);
        rules.slice(0, 4).forEach((r, i) => { form[`r_subject_${i}`].value = r.subject || ''; form[`r_grade_${i}`].value = r.grade || ''; form[`r_batch_${i}`].value = r.batch_type || ''; form[`r_rate_${i}`].value = r.rate; });
      },
      onSubmit: async (f) => {
        const rates = [0, 1, 2, 3].map((i) => ({ subject: f[`r_subject_${i}`], grade: f[`r_grade_${i}`], batch_type: f[`r_batch_${i}`], rate: f[`r_rate_${i}`] })).filter((r) => Number(r.rate) > 0);
        for (const k of Object.keys(f)) if (k.startsWith('r_')) delete f[k];
        if (!f.bank_details) delete f.bank_details;
        const saved = t.id ? await api('PATCH', `/teachers/${t.id}`, f) : await post('/teachers', f);
        await api('PUT', `/teachers/${saved.id || t.id}/rates`, { rates });
        S.meta = await get('/meta'); toast('Teacher saved'); reload();
      },
    });
  }
  async function pageTeachers() {
    const rows = await get('/teachers');
    setPage(`<div class="page-head"><div><h1>Teachers</h1><div class="muted">${rows.filter((t) => t.status === 'Active').length} active</div></div>${can('teachers.edit') ? '<div class="actions"><button class="primary" id="nt">New teacher</button></div>' : ''}</div>
      <div class="table-wrap"><table><thead><tr><th>Teacher</th><th>Subjects</th><th>Grades / boards</th><th>Availability</th>${can('payouts.view') ? '<th class="r">Rate/hr</th>' : ''}<th class="r">Students</th><th class="r">Paid hrs this month</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((t) => `<tr><td><b>${esc(t.name)}</b><div class="small muted">${esc(t.country)} · ${esc(t.currency)}</div></td><td>${esc(t.subjects || '')}</td><td class="small">${esc(t.grades || '')}<div class="muted">${esc(t.boards || '')}</div></td>
        <td class="small">${esc(t.availability || '')}</td>${can('payouts.view') ? `<td class="r num">${money(t.rate_per_hour, t.currency)}</td>` : ''}<td class="r num">${t.active_students}</td><td class="r num">${t.month_hours}</td><td>${pill(t.status)}</td>
        <td class="r" style="white-space:nowrap">${can('teachers.edit') ? `<button class="small" data-edit="${t.id}">Edit</button> <button class="small" data-portal="${t.id}">Class link</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`);
    $('#nt') && ($('#nt').onclick = () => teacherModal());
    $$('[data-portal]').forEach((b) => { b.onclick = async () => {
      const r = await get(`/teachers/${b.dataset.portal}/portal-link`);
      const url = location.origin + r.path;
      modal({ title: 'Teacher class link', body: `<p class="small muted">The teacher opens this after each class to confirm it in one tap. It shows only the child's first name, grade and subject – never parent contacts. It is sent automatically on WhatsApp when classes are scheduled.</p>
        <input readonly value="${esc(url)}" id="plink"><div style="display:flex;gap:8px;margin-top:10px"><button class="primary" id="pcopy">Copy link</button><button id="prot" class="danger">Make a new link</button></div>` });
      $('#pcopy').onclick = () => { navigator.clipboard?.writeText(url); toast('Link copied'); };
      $('#prot').onclick = async () => { if (!confirm('The old link stops working. Continue?')) return; const n = await post(`/teachers/${b.dataset.portal}/portal-link/rotate`); $('#plink').value = location.origin + n.path; toast('New link created'); };
    }; });
    $$('[data-edit]').forEach((b) => { b.onclick = () => teacherModal(rows.find((t) => String(t.id) === b.dataset.edit)); });
  }

  // ---------------- accounts ----------------
  async function pageAccounts() {
    const p = qs();
    const tab = p.tab || 'payments';
    const month = p.month || new Date().toISOString().slice(0, 7);
    const head = `<div class="page-head"><div><h1>Accounts</h1></div>${can('exports') ? '<div class="actions"><button id="exp">Export payments CSV</button></div>' : ''}</div>
      <nav class="views">${[['payments', 'All payments'], ...(can('payments.approve') ? [['verify', 'To verify']] : []), ['due', 'Instalments due'], ['refunds', 'Refunds'], ...(can('expenses.edit') ? [['expenses', 'Expenses']] : []), ...(can('reports.finance') ? [['report', 'Monthly report']] : [])]
    .map(([v, l]) => `<a href="#/accounts?tab=${v}" class="${v === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>`;
    if (tab === 'expenses') {
      const rows = await get(`/expenses?month=${month}`);
      setPage(`${head}<form class="filters" id="mf"><input type="hidden" name="tab" value="expenses"><input type="month" name="month" value="${month}"><button>Show</button><div style="flex:1"></div><button type="button" class="primary" id="ne">Add expense</button></form>
        <div class="table-wrap">${rows.length ? `<table><thead><tr><th>Month</th><th>Category</th><th>Source (for CAC)</th><th class="r">Amount</th><th>Note</th></tr></thead><tbody>${rows.map((e) => `<tr><td>${esc(e.month)}</td><td>${esc(e.category)}</td><td>${esc(e.source || '—')}</td><td class="r num">${money(e.amount, e.currency)}</td><td>${esc(e.note || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No expenses for this month. Add ad spend by source to see CAC in the monthly report.</div>'}</div>`);
      $('#ne').onclick = () => modal({ title: 'Add expense', body: `<div class="grid2">${field('Category', select('category', ['Ad Spend', 'Tools', 'Salaries', 'Other'], 'Ad Spend'))}${field('Lead source (ad spend)', select('source', S.meta.leadSources, '', '—'))}</div>
        <div class="grid3">${field('Amount', input('amount', '', 'number', 'required'))}${field('Currency', select('currency', ['AED', 'INR'], 'AED'))}${field('Month', input('month', month, 'month'))}</div>${field('Note', input('note'))}`,
      onSubmit: async (f) => { await post('/expenses', f); toast('Expense added'); reload(); } });
    } else if (tab === 'report') {
      const r = await get(`/reports/finance?month=${month}`);
      const rowsOf = (obj) => Object.entries(obj).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r num">${money(v.AED, 'AED')}</td><td class="r num">${money(v.INR, 'INR')}</td><td class="r num">${money(v.combinedAED, 'AED')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No revenue</td></tr>';
      const block = (title, obj) => `<div class="panel flush"><div style="padding:14px 16px 0"><h2>${title}</h2></div><table><thead><tr><th></th><th class="r">AED</th><th class="r">INR</th><th class="r">Combined (AED)</th></tr></thead><tbody>${rowsOf(obj)}</tbody></table></div>`;
      setPage(`${head}<form class="filters" id="mf"><input type="hidden" name="tab" value="report"><input type="month" name="month" value="${month}"><button>Show</button></form>
        <div class="kpis">${kpi(money(r.revenue.combinedAED, 'AED'), 'Revenue')}${kpi(money(r.newRevenue.combinedAED, 'AED'), 'New')}${kpi(money(r.renewalRevenue.combinedAED, 'AED'), 'Renewal')}
          ${kpi(money(r.payouts.combinedAED, 'AED'), 'Teacher payouts')}${kpi(money(r.expenses.combinedAED, 'AED'), 'Expenses incl. ads')}${kpi(money(r.refunds.combinedAED, 'AED'), 'Refunds')}
          ${kpi(money(r.outstanding.combinedAED, 'AED'), 'Outstanding receivables', r.outstanding.combinedAED > 0)}${kpi(money(r.netMarginAED, 'AED'), 'Net margin', r.netMarginAED < 0)}</div>
        <div class="dash-grid">${block('By market', r.byMarket)}${block('By source', r.bySource)}${block('By sales rep', r.byRep)}${block('By package type', r.byPackageKind)}
          <div class="panel flush"><div style="padding:14px 16px 0"><h2>CAC by source</h2></div><table><thead><tr><th>Source</th><th class="r">Ad spend (AED)</th><th class="r">New students</th><th class="r">CAC (AED)</th></tr></thead><tbody>
            ${Object.entries(r.cac).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r num">${v.spendAED.toLocaleString()}</td><td class="r num">${v.conversions}</td><td class="r num">${v.cacAED === null ? '—' : v.cacAED.toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Add ad spend under Expenses.</td></tr>'}</tbody></table></div></div>
        <p class="muted small">Net margin = revenue – refunds – teacher payouts – expenses (ad spend, tools, salaries). Combined at 1 AED = ${S.meta.exchangeRate.INR_PER_AED} INR.</p>`);
    } else {
      const query = tab === 'due' ? '?due=3' : tab === 'verify' ? '?verify=1' : '';
      let rows = await get(`/payments${query}`);
      if (tab === 'refunds') rows = rows.filter((x) => x.status.startsWith('Refund'));
      if (tab === 'verify') {
        setPage(`${head}<p class="muted">Payments recorded by sales. Check each one against the bank statement or payment gateway, then verify. Target: within 24 hours.</p>
          <div class="table-wrap">${rows.length ? `<table><thead><tr><th>Invoice</th><th>Student</th><th class="r">Amount</th><th>Method · reference</th><th>Received</th><th>Recorded by</th><th></th></tr></thead><tbody>
          ${rows.map((x) => `<tr><td>${esc(x.invoice_no)}</td><td><a href="#/students/${x.student_id}">${esc(x.child_name || '')}</a></td><td class="r num">${money(x.amount, x.currency)}</td>
            <td class="small">${esc([x.method, x.reference].filter(Boolean).join(' · '))}</td><td class="${(Date.now() - new Date(x.paid_at)) > 864e5 ? 'due-over' : ''}">${dt(x.paid_at)}</td><td>${esc(x.collected_by_name || '—')}</td>
            <td class="r"><button class="small primary" data-vf="${x.id}">Verify</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Every received payment is verified.</div>'}</div>`);
        $$('[data-vf]').forEach((b) => { b.onclick = async () => { await post(`/payments/${b.dataset.vf}/verify`); toast('Payment verified'); reload(); }; });
        $('#exp') && ($('#exp').onclick = () => openDoc('/export/payments.csv', 'payments.csv'));
        return;
      }
      setPage(`${head}${tab === 'due' ? '<p class="muted">Pending instalments overdue or due in the next 3 days. Parents and Accounts are reminded 3 days before, on the day and when overdue.</p>' : ''}
        <div class="table-wrap">${paymentTable(rows, { student: true })}</div>`);
      bindPayments();
    }
    const mf = $('#mf'); if (mf) mf.onsubmit = (e) => { e.preventDefault(); location.hash = `#/accounts?${new URLSearchParams(formData(mf))}`; };
    $('#exp') && ($('#exp').onclick = () => openDoc('/export/payments.csv', 'payments.csv'));
  }

  // ---------------- payouts ----------------
  async function pagePayouts() {
    const p = qs();
    const cycle = S.settings?.payouts?.cycle || 'monthly';
    const nowIso = new Date().toISOString();
    const month = p.month || (cycle === 'fortnightly' ? `${nowIso.slice(0, 7)}-${Number(nowIso.slice(8, 10)) <= 15 ? 'H1' : 'H2'}` : nowIso.slice(0, 7));
    const [rows, live, rec] = await Promise.all([get(`/payouts?month=${month}`), get(`/payouts/live?month=${month}`), get(`/payouts/reconcile?month=${month}`)]);
    const mism = rec.filter((r) => r.mismatch);
    setPage(`<div class="page-head"><div><h1>Teacher payouts</h1><div class="muted">Built from attendance: only classes that qualify for pay</div></div>
      <div class="actions">${can('payouts.adjust') ? '<button class="primary" id="gen">Generate statements</button>' : ''}</div></div>
      <form class="filters" id="pf"><input type="month" name="month" value="${month.slice(0, 7)}">${cycle === 'fortnightly' || month.length > 7 ? select('half', [['H1', '1st – 15th'], ['H2', '16th – end'], ['', 'Whole month']], month.slice(8)) : ''}<button>Show period</button></form>
      ${mism.length ? `<div class="callout red">Attendance and payout hours don't match for ${mism.map((m) => esc(m.name)).join(', ')}. Regenerate the statements after attendance changes.</div>` : rows.length ? '<div class="callout green">Payout hours reconcile with attendance.</div>' : ''}
      <div class="table-wrap">${rows.length ? `<table><thead><tr><th>Teacher</th><th>Currency</th><th class="r">Hours</th><th class="r">Gross</th><th class="r">Adjustments</th><th class="r">Net payable</th><th>Status</th><th></th></tr></thead><tbody>
        ${rows.map((x) => `<tr><td><b>${esc(x.teacher_name)}</b><div class="small muted">${esc(x.country)}${x.locked ? ' · locked' : ''}</div></td><td>${esc(x.currency)}</td><td class="r num">${x.hours}</td>
          <td class="r num">${money(x.gross)}</td><td class="r num">${money(x.adjustments)}${x.adjustment_note ? `<div class="small muted">${esc(x.adjustment_note)}</div>` : ''}</td><td class="r num"><b>${money(x.net, x.currency)}</b></td>
          <td>${pill(x.status)}${x.paid_at ? `<div class="small muted">${d(x.paid_at)} · ${esc(x.pay_mode)}</div>` : ''}</td>
          <td class="r" style="white-space:nowrap">${x.status === 'Pending' && can('payouts.adjust') ? `<button class="small" data-adj="${x.id}">Adjust</button>` : ''}
            ${x.status === 'Pending' && can('payouts.approve') ? `<button class="small" data-appr="${x.id}">Approve</button>` : ''}
            ${x.status === 'Approved' && can('payouts.approve') ? `<button class="small primary" data-paid="${x.id}">Mark paid</button>` : ''}
            ${x.locked && can('payouts.unlock') ? `<button class="small" data-unl="${x.id}">Unlock</button>` : ''}
            <button class="small link" data-stm="${x.id}">Statement</button></td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No statements for this month yet. Generate them from attendance – it happens automatically on the 1st for the previous month.</div>'}</div>
      <h2 style="margin-top:22px">Running totals from attendance</h2>
      <div class="table-wrap"><table><thead><tr><th>Teacher</th><th class="r">Paid hours</th><th class="r">Gross so far</th><th>Breakdown</th></tr></thead><tbody>
        ${live.map((t) => `<tr><td>${esc(t.name)}</td><td class="r num">${t.hours}</td><td class="r num">${money(t.gross, t.currency)}</td><td class="small">${t.lines.map((l) => `${esc(l.student)} · ${esc(l.subject)}: ${l.hours}h${l.demo ? ' (demo)' : ''}`).join('<br>') || '—'}</td></tr>`).join('')}</tbody></table></div>`);
    $('#pf').onsubmit = (e) => { e.preventDefault(); const h = e.target.half?.value; location.hash = `#/payouts?month=${e.target.month.value}${h ? `-${h}` : ''}`; };
    const g = $('#gen'); if (g) g.onclick = async () => { const r = await post('/payouts/generate', { month }); toast(`${r.length} statements ready`); reload(); };
    $$('[data-adj]').forEach((b) => { b.onclick = () => { const x = rows.find((r) => String(r.id) === b.dataset.adj); modal({ title: `Adjust – ${x.teacher_name}`,
      body: `${field(`Adjustment (${x.currency}, use minus for penalty)`, input('adjustments', x.adjustments, 'number', 'step="0.01"'))}${field('Reason', input('note', x.adjustment_note || '', 'text', 'placeholder="Bonus, absence penalty, demo rate…"'))}`,
      onSubmit: async (f) => { await post(`/payouts/${x.id}/adjust`, f); toast('Adjustment saved'); reload(); } }); }; });
    $$('[data-appr]').forEach((b) => { b.onclick = async () => { await post(`/payouts/${b.dataset.appr}/approve`); toast('Payout approved'); reload(); }; });
    $$('[data-paid]').forEach((b) => { b.onclick = () => modal({ title: 'Mark payout paid', submit: 'Mark paid and lock month',
      body: `<div class="grid2">${field('Mode', select('mode', ['Bank transfer', 'UPI', 'Cash'], 'Bank transfer'))}${field('Reference', input('reference', '', 'text', 'required'))}</div><p class="small muted">The statement is sent to the teacher and the month is locked. Only the Owner can unlock it.</p>`,
      onSubmit: async (f) => { await post(`/payouts/${b.dataset.paid}/pay`, f); toast('Paid – statement sent'); reload(); } }); });
    $$('[data-unl]').forEach((b) => { b.onclick = async () => { if (!confirm('Unlock this paid month? It returns to Pending.')) return; await post(`/payouts/${b.dataset.unl}/unlock`); toast('Unlocked'); reload(); }; });
    $$('[data-stm]').forEach((b) => { b.onclick = () => openDoc(`/payouts/${b.dataset.stm}/statement`); });
  }

  // ---------------- users ----------------
  async function pageUsers() {
    const rows = await get('/users');
    const roleOpts = Object.entries(S.meta.roles);
    const userModal = (u = {}) => modal({ title: u.id ? `Edit ${u.name}` : 'New user',
      body: `<div class="grid2">${field('Name', input('name', u.name, 'text', 'required'))}${field('Email', input('email', u.email, 'email', u.id ? 'disabled' : 'required'))}</div>
        <div class="grid3">${field('Role', select('role', roleOpts, u.role || 'sales_exec'))}${field('Market (sales round-robin)', select('market', ['UAE', 'India'], u.market, '—'))}${field('WhatsApp / phone', input('phone', u.phone))}</div>
        <div class="grid2">${field(u.id ? 'New password (optional)' : 'Password', input('password', '', 'password', u.id ? '' : 'required'))}${u.id ? field('Status', select('active', [[1, 'Active'], [0, 'Inactive']], u.active)) : '<div></div>'}</div>`,
      onSubmit: async (f) => { if (u.id) await api('PATCH', `/users/${u.id}`, { ...f, active: f.active === undefined ? undefined : Number(f.active) }); else await post('/users', f); S.meta = await get('/meta'); toast('User saved'); reload(); } });
    setPage(`<div class="page-head"><div><h1>Users & roles</h1><div class="muted">Sales executives with a market join that market's round-robin</div></div><div class="actions"><button class="primary" id="nu">New user</button><button id="run">Run automation now</button></div></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Market</th><th>Two-step</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(S.meta.roles[u.role])}</td><td>${esc(u.market || '—')}</td>
        <td>${u.totp_enabled ? '<span class="pill green">On</span>' : ['owner', 'admin', 'accounts'].includes(u.role) ? '<span class="pill amber">Required at next sign-in</span>' : '<span class="pill">Optional</span>'}</td>
        <td>${u.active ? pill('Active') : pill('Inactive')}</td><td class="r" style="white-space:nowrap"><button class="small" data-u="${u.id}">Edit</button>${u.totp_enabled ? ` <button class="small" data-r2="${u.id}">Reset 2FA</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="panel" style="margin-top:16px"><h2>What each role can do</h2><dl class="fields">
        <dt>Sales Executive</dt><dd>Own leads, log calls and WhatsApp, follow-ups, KYC capture, convert, retention follow-ups. Cannot assign teachers, see payouts or edit attendance.</dd>
        <dt>Sales Manager</dt><dd>All leads, reassign, approve instalment plans and refunds, team dashboard. Cannot edit payouts.</dd>
        <dt>Admin / Ops</dt><dd>Verify KYC, student stages, teacher assignment, schedules, attendance, payout adjustments. Cannot delete lead history.</dd>
        <dt>Accounts</dt><dd>Payments, invoices, refunds processing, expenses, payout approval and payment. Cannot edit lead stages.</dd>
        <dt>Owner</dt><dd>Everything, including unlocking paid payout months.</dd></dl></div>`);
    $('#nu').onclick = () => userModal();
    $('#run').onclick = async () => { const r = await post('/automation/run'); toast(`Automation ran: ${r.leadRules.reassigned} reassigned, ${r.followUps} reminders`); };
    $$('[data-u]').forEach((b) => { b.onclick = () => userModal(rows.find((u) => String(u.id) === b.dataset.u)); });
    $$('[data-r2]').forEach((b) => { b.onclick = async () => { if (!confirm('Reset two-step sign-in? They will set it up again at next sign-in (lost phone).')) return; await post(`/users/${b.dataset.r2}/reset-2fa`); toast('2FA reset'); reload(); }; });
  }

  setInterval(() => { if (S.me) refreshBell(); }, 60000);
  boot();
})();
