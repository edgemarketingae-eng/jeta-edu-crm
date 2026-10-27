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
    if (res.status === 401 && path !== '/login') { logout(); throw new Error('Please sign in again'); }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data.error || data || `Request failed (${res.status})`);
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
    Hot: 'red', Warm: 'amber', Overdue: 'red', Inactive: '', Unmarked: 'red', Demo: 'blue', High: 'red', Cold: 'blue', Submitted: 'blue', Verified: 'green', Rejected: 'red',
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
    onOpen?.(form);
    $('input,select,textarea', form)?.focus();
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
        <p class="muted small" style="margin-top:18px">Demo: owner@jeta.edu, manager@, aisha@, admin@, accounts@ – password jeta1234</p></form></div>`;
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try {
        const r = await post('/login', f);
        S.token = r.token; localStorage.setItem('jeta_token', r.token);
        await boot();
      } catch (err) { const el = $('.err', e.target); el.textContent = err.message; el.hidden = false; }
    });
  }

  async function boot() {
    if (!S.token) return renderLogin();
    try {
      const me = await get('/me');
      S.me = me.user; S.perms = me.perms; S.meta = await get('/meta');
      if (!location.hash) location.hash = '#/dashboard';
      route();
    } catch { renderLogin(); }
  }

  // ---------------- layout ----------------
  const NAV = [
    ['Sales', [['#/dashboard', 'Dashboard'], ['#/leads', 'Leads', 'overdue'], ['#/pipeline', 'Pipeline'], ['#/tasks', 'My tasks']]],
    ['Academics', [['#/students', 'Students'], ['#/classes', 'Classes & attendance', null, 'students.view'], ['#/teachers', 'Teachers', null, 'teachers.view']]],
    ['Finance', [['#/accounts', 'Accounts', null, 'payments.edit'], ['#/payouts', 'Teacher payouts', null, 'payouts.view']]],
    ['Admin', [['#/users', 'Users & roles', null, 'users.manage']]],
  ];

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
      <aside class="side"><div class="brand"><span class="mark">J</span> Jeta Edu CRM</div><nav class="nav">${nav}</nav>
        <div class="me"><div>${esc(S.me.name)}</div><div class="small" style="color:#9EC2B6">${esc(S.meta.roles[S.me.role])}${S.me.market ? ` · ${esc(S.me.market)}` : ''}</div>
        <button id="logout" class="small">Sign out</button></div></aside>
      <div class="main"><header class="top">
        <input class="search" id="gsearch" placeholder="Search leads by name, phone or ID" aria-label="Search leads">
        <div style="flex:1"></div>
        ${can('leads.edit') ? '<button class="primary" id="quick-lead">New lead</button>' : ''}
        <button class="bell" id="bell" aria-label="Notifications">Alerts <span class="dot" id="bell-dot" hidden></span></button>
      </header><main class="page" id="page">${content}</main></div></div>`;
    $('#logout').onclick = logout;
    $('#bell').onclick = openNotifications;
    $('#quick-lead') && ($('#quick-lead').onclick = newLeadModal);
    $('#gsearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = `#/leads?view=all&search=${encodeURIComponent(e.target.value)}`; });
    refreshBell();
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
    [/^#\/tasks$/, pageTasks], [/^#\/users$/, pageUsers],
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
  const setPage = (html) => { $('#page').innerHTML = html; };

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
    const periods = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom']];
    setPage(`<div class="page-head"><div><h1>Dashboard</h1><div class="muted">${d(x.range.from)} – ${d(new Date(new Date(x.range.to) - 1).toISOString())}${role() === 'sales_exec' ? ' · your numbers' : ''}</div></div></div>
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
        ${kpi(x.sales.followUpsDueToday, 'Follow-ups due today')}${kpi(x.sales.followUpsOverdue, 'Follow-ups overdue', x.sales.followUpsOverdue > 0)}</div>

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
      onSubmit: async (f) => { const l = await post('/leads', f); toast(`Lead ${l.code} created${l.owner_id ? '' : ' – no rep available'}`); location.hash = `#/leads/${l.id}`; },
    });
  }

  async function pageLeads() {
    const p = qs();
    const view = p.view || 'open';
    const params = new URLSearchParams({ view, ...p });
    const rows = await get(`/leads?${params}`);
    const views = [['open', 'All open'], ['today', "Today's follow-ups", 'today'], ['overdue', 'Overdue', 'overdue', true], ['upcoming', 'Next 7 days', 'upcoming'],
      ['untouched', 'Not touched 48h', 'untouched', true], ['expiring', 'Expiring (day 25+)', 'expiring', true], ['nurture', 'Nurture'], ['flagged', 'Flagged'], ['all', 'All leads']];
    setPage(`<div class="page-head"><div><h1>Leads</h1><div class="muted">${rows.length} shown${role() === 'sales_exec' ? ' · your leads' : ''}</div></div>
      <div class="actions">${can('dashboard.team') ? '<button id="exp">Export CSV</button>' : ''}<a class="btn" href="#/pipeline">Pipeline view</a>${can('leads.edit') ? '<button class="primary" id="nl">New lead</button>' : ''}</div></div>
      <nav class="views">${views.map(([v, l, ck, alert]) => `<a href="#/leads?view=${v}" class="${v === view ? 'on' : ''} ${alert && S.counts[ck] ? 'alert' : ''}">${l}${ck ? `<span class="n">${S.counts[ck] ?? 0}</span>` : ''}</a>`).join('')}</nav>
      <form class="filters" id="lf"><input type="hidden" name="view" value="${esc(view)}">
        <input name="search" placeholder="Name, phone, ID" value="${esc(p.search || '')}">
        ${select('stage', S.meta.leadStages, p.stage, 'Any stage')}${select('source', S.meta.leadSources, p.source, 'Any source')}
        ${role() !== 'sales_exec' ? select('owner', salesUsers(), p.owner, 'Any owner') : ''}${select('country', ['UAE', 'India'], p.country, 'Any market')}
        ${select('score', ['Hot', 'Warm', 'Cold'], p.score, 'Any score')}<button>Filter</button></form>
      <div class="table-wrap">${rows.length ? `<table><thead><tr><th>Lead</th><th>Child</th><th>Source</th><th>Stage</th><th>Score</th><th>Owner</th><th>Next follow-up</th><th class="r">Attempts</th><th>Assigned</th></tr></thead><tbody>
        ${rows.map((l) => `<tr class="click" data-href="#/leads/${l.id}"><td><a href="#/leads/${l.id}"><b>${esc(l.parent_name)}</b></a>${l.flagged ? ' ' + pill('Flagged') : ''}<div class="small muted">${esc(l.code)} · ${esc(l.phone)}</div></td>
          <td>${esc(l.child_name || '—')}<div class="small muted">${esc([l.grade && `Gr ${l.grade}`, l.board, l.subjects].filter(Boolean).join(' · '))}</div></td>
          <td>${esc(l.source)}<div class="small muted">${esc(l.country)}</div></td><td>${pill(l.stage)}</td><td>${pill(l.score)}</td><td>${esc(l.owner_name || 'Unassigned')}</td>
          <td>${['Converted', 'Lost'].includes(l.stage) ? '—' : dueCell(l.next_follow_up_at)}</td><td class="r num">${l.attempt_count}</td>
          <td class="small">${ago(l.assigned_at)}${l.reassignment_count ? `<div class="muted">reassigned ${l.reassignment_count}×</div>` : ''}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No leads in this view. Change the filters or add a new lead.</div>'}</div>`);
    $('#nl') && ($('#nl').onclick = newLeadModal);
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
  const ICON = { call: 'C', whatsapp: 'W', note: 'N', stage: 'S', reassign: 'R', system: '·', kyc: 'K', payment: '$', class: 'L' };
  const timeline = (acts) => (acts.length ? `<ul class="timeline">${acts.map((a) => `<li><span class="ico ${a.type}">${ICON[a.type] || '·'}</span><div>
    <div class="when">${dt(a.created_at)} · ${esc(a.user_name || 'System')}${a.outcome ? ` · <b>${esc(a.outcome)}</b>` : ''}</div>
    <div class="body">${esc(a.body || '')}</div></div></li>`).join('')}</ul>` : '<div class="muted small">Nothing logged yet.</div>');

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
        <div class="muted">${esc(l.code)} · ${esc(l.phone)}${l.is_whatsapp ? ' (WhatsApp)' : ''} · ${esc(l.email || 'no email')}</div></div>
        <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">${editable ? `<button class="primary" id="a-call">Log call</button><button id="a-wa">Log WhatsApp</button>
          ${!closed ? '<button id="a-stage">Change stage</button><button id="a-fu">Set follow-up</button>' : ''}
          ${l.stage === 'Lost' ? '<button id="a-reopen">Reopen</button>' : ''}
          ${!closed ? '<button id="a-conv">Convert</button>' : ''}` : ''}
          ${can('leads.reassign') && !closed ? '<button id="a-re">Reassign</button>' : ''}
          ${l.student_id ? `<a class="btn" href="#/students/${l.student_id}">Open student</a>` : ''}</div></div>
        <div class="meta"><span>Owner <b>${esc(l.owner_name || 'Unassigned')}</b></span><span>Next follow-up <b>${closed ? '—' : dueCell(l.next_follow_up_at)}</b> ${l.next_follow_up_type ? `<span class="muted">(${esc(l.next_follow_up_type)})</span>` : ''}</span>
          <span>Attempts <b>${l.attempt_count}</b></span><span>Assigned <b>${age === null ? '—' : `day ${age} of 30`}</b>${l.reassignment_count ? ` · reassigned ${l.reassignment_count}×` : ''}</span>
          <span>Source <b>${esc(l.source)}</b>${l.campaign ? ` / ${esc(l.campaign)}` : ''}</span><span>Market <b>${esc(l.country)} (${esc(l.currency)})</b></span></div>
        ${stageTrack}</div>
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
        <div data-pane="4" class="panel flush" hidden>${taskTable(x.tasks)}</div>
      </div>
      <div><div class="panel"><div class="panel-head"><h2>Timeline</h2></div>
        ${editable ? '<form id="note-f" style="margin-bottom:10px"><textarea name="text" placeholder="Add a note" style="min-height:50px"></textarea><button style="margin-top:6px">Add note</button></form>' : ''}
        ${timeline(x.activities)}</div></div></div>`);

    $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
      $$('.tabs button').forEach((x2) => x2.classList.toggle('on', x2 === b));
      $$('[data-pane]').forEach((p2) => { p2.hidden = p2.dataset.pane !== b.dataset.tab; });
    }));
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    on('#a-call', () => callModal(l));
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

  function callModal(l) {
    modal({
      title: `Log call – ${l.parent_name}`, submit: 'Log call',
      body: `${field('Outcome *', select('outcome', S.meta.callOutcomes, '', 'Choose outcome', 'required id="oc"'))}
        <div id="oc-interested" hidden>${field('Move to', select('stage', ['Contacted', 'Qualified'], l.stage === 'Qualified' ? 'Qualified' : 'Contacted'))}</div>
        <div id="oc-fu" hidden>${followUpFields(inHours(24))}</div>
        <div id="oc-lost" hidden><div class="grid2">${field('Move to', select('move_to', ['Lost', 'Nurture'], 'Lost'))}${field('Lost reason', select('lost_reason', S.meta.lostReasons, '', 'Choose reason'))}</div>
          <div class="small muted" style="margin-top:-6px;margin-bottom:10px">For Nurture, set the revisit date below.</div></div>
        <div id="oc-auto" class="callout" hidden></div>
        <div class="grid2">${field('Duration (min)', input('duration_min', '', 'number', 'min="0"'))}<div></div></div>
        ${field('Notes', '<textarea name="notes"></textarea>')}`,
      onOpen: (form) => {
        const oc = $('#oc', form);
        oc.onchange = () => {
          const v = oc.value;
          $('#oc-interested', form).hidden = v !== 'Connected - Interested';
          $('#oc-fu', form).hidden = !['Connected - Interested', 'Connected - Call back later'].includes(v) && !(v === 'Connected - Not interested');
          $('#oc-lost', form).hidden = v !== 'Connected - Not interested';
          const auto = { 'Not answered': `Stage → Attempted, WhatsApp task created${l.attempt_count === 0 ? '' : ' if due'}, retry scheduled automatically.`, 'Busy / Switched off': 'Retry scheduled in 3 hours (same day).', 'Wrong number': 'Lead is flagged for manager review.' }[v];
          $('#oc-auto', form).hidden = !auto; $('#oc-auto', form).textContent = `${auto || ''} Attempt ${l.attempt_count + 1} of 6.`;
          $$('#oc-fu input, #oc-fu select, #oc-interested select, #oc-lost select', form).forEach((el) => { el.disabled = el.closest('[hidden]') !== null; });
        };
        oc.onchange();
      },
      onSubmit: async (f) => { const r = await post(`/leads/${l.id}/call`, f); toast(`Call logged · ${r.stage}`); reload(); },
    });
  }

  function waModal(l) {
    const templates = ['Intro + brochure', 'Demo confirmation', 'Payment reminder', 'Follow-up nudge', 'Manual'];
    modal({
      title: `Log WhatsApp – ${l.parent_name}`, submit: 'Log message',
      body: `${field('Template', select('template', templates, 'Intro + brochure'))}${field('Message / note', '<textarea name="message"></textarea>')}
        <label class="check"><input type="checkbox" name="replied"> Parent replied</label>
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
      ${can('dashboard.team') ? '<div class="actions"><button id="exp">Export CSV</button></div>' : ''}</div>
      <nav class="views">${[['all', 'All'], ['unassigned', 'Awaiting teacher'], ['renewal', 'Due for renewal']].map(([v, l]) => `<a href="#/students?view=${v}" class="${v === view ? 'on' : ''}">${l}</a>`).join('')}</nav>
      <form class="filters" id="sf"><input type="hidden" name="view" value="${esc(view)}"><input name="search" placeholder="Child, parent, ID" value="${esc(p.search || '')}">
        ${select('stage', S.meta.studentStages, p.stage, 'Any stage')}${select('retention', S.meta.retentionStages, p.retention, 'Any retention stage')}
        ${select('teacher', S.meta.teachers.map((t) => [t.id, t.name]), p.teacher, 'Any teacher')}${select('country', ['UAE', 'India'], p.country, 'Any market')}<button>Filter</button></form>
      <div class="table-wrap">${rows.length ? `<table><thead><tr><th>Student</th><th>Subjects</th><th>Stage</th><th>Retention</th><th>Teacher</th><th>Hours</th><th>Retention owner</th></tr></thead><tbody>
        ${rows.map((s) => `<tr class="click" data-href="#/students/${s.id}"><td><a href="#/students/${s.id}"><b>${esc(s.child_name)}</b></a><div class="small muted">${esc(s.code)} · ${esc(s.parent_name)}</div></td>
          <td>${esc(s.subjects || '')}<div class="small muted">${esc([s.grade && `Gr ${s.grade}`, s.board, s.country].filter(Boolean).join(' · '))}</div></td>
          <td>${pill(s.stage)}</td><td>${pill(s.retention_stage) || '<span class="muted">—</span>'}</td><td>${esc(s.teacher_name || '—')}${s.batch_name ? `<div class="small muted">${esc(s.batch_name)}</div>` : ''}</td>
          <td>${miniMeter(s)}</td><td>${esc(s.retention_owner_name || '—')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No students here yet. Students appear when a lead is converted.</div>'}</div>`);
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
        <div class="muted">${esc(s.code)} · Parent ${esc(s.parent_name)}${role() !== 'admin' ? ` · ${esc(s.phone)}` : ''} · ${esc(s.country)} (${esc(s.currency)})</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${admin ? `<button class="primary" id="b-assign">${s.teacher_id ? 'Change teacher' : 'Assign teacher'}</button>${s.teacher_id ? '<button id="b-sched">Schedule classes</button><button id="b-class">Add class</button>' : ''}<button id="b-stage">Change stage</button>` : ''}
          ${ret ? '<button id="b-rlog">Log retention call</button><button id="b-rstage">Retention stage</button><button id="b-renew">Renew</button>' : ''}
          ${s.lead_id ? `<a class="btn" href="#/leads/${s.lead_id}">Open lead</a>` : ''}</div></div>
        <div class="meta"><span>Teacher <b>${esc(x.teacher?.name || 'Not assigned')}</b>${s.batch_type ? ` · ${esc(s.batch_type)}${s.batch_name ? ` ${esc(s.batch_name)}` : ''}` : ''}</span>
          <span>Schedule <b>${s.schedule_days ? `${esc(s.schedule_days)} at ${esc(s.schedule_time)} (${esc(s.timezone)})` : '—'}</b></span>
          <span>Subjects <b>${esc(s.subjects || '—')}</b></span><span>Retention owner <b>${esc(s.retention_owner_name || '—')}</b></span><span>Joined <b>${d(s.joined_at)}</b></span></div>
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
      <div><div class="panel"><h2>Timeline</h2><form id="note-f" style="margin-bottom:10px"><textarea name="text" placeholder="Add a note" style="min-height:50px"></textarea><button style="margin-top:6px">Add note</button></form>${timeline(x.activities)}</div></div></div>`);

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
    on('#b-sched', () => modal({
      title: 'Schedule classes', submit: 'Create classes',
      body: `<label>Days</label><div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((dd) => `<label class="check"><input type="checkbox" data-multi="1" name="days" value="${dd}" ${(s.schedule_days || '').includes(dd.toLowerCase()) ? 'checked' : ''}> ${dd}</label>`).join('')}</div>
        <div class="grid3">${field('Time', input('time', s.schedule_time || '17:00', 'time'))}${field('Time zone', select('timezone', [['Asia/Dubai', 'UAE (GST)'], ['Asia/Kolkata', 'India (IST)']], s.timezone))}${field('Hours per class', input('duration_hours', '1', 'number', 'min="0.5" step="0.5"'))}</div>
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
      <div class="grid2">${field('Email', input('email', s.email))}${field('City', input('city', s.city))}</div>`,
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
    const rows = await get(`/classes?${params}`);
    setPage(`<div class="page-head"><div><h1>Classes & attendance</h1><div class="muted">${rows.length} classes</div></div>${can('dashboard.team') ? '<div class="actions"><button id="exp">Export CSV</button></div>' : ''}</div>
      <nav class="views">${[['week', 'Next 7 days'], ['past', 'Last 14 days'], ['unmarked', 'Unmarked']].map(([v, l]) => `<a href="#/classes?filter=${v}" class="${v === filter ? 'on' : ''}">${l}</a>`).join('')}</nav>
      <form class="filters" id="cf"><input type="hidden" name="filter" value="${esc(filter)}">${select('teacher', S.meta.teachers.map((t) => [t.id, t.name]), p.teacher, 'All teachers')}<button>Filter</button></form>
      ${filter === 'unmarked' && rows.length ? '<div class="callout red">These classes are past but not marked. Hours and teacher payouts stay wrong until attendance is recorded.</div>' : ''}
      <div class="table-wrap">${classRows(rows, { mark: true })}</div>`);
    bindAttendance(rows);
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
        <p class="small muted">Payout currency follows country: UAE → AED, India → INR. Currencies are never mixed in one payout.</p>`,
      onSubmit: async (f) => { if (t.id) await api('PATCH', `/teachers/${t.id}`, f); else await post('/teachers', f); S.meta = await get('/meta'); toast('Teacher saved'); reload(); },
    });
  }
  async function pageTeachers() {
    const rows = await get('/teachers');
    setPage(`<div class="page-head"><div><h1>Teachers</h1><div class="muted">${rows.filter((t) => t.status === 'Active').length} active</div></div>${can('teachers.edit') ? '<div class="actions"><button class="primary" id="nt">New teacher</button></div>' : ''}</div>
      <div class="table-wrap"><table><thead><tr><th>Teacher</th><th>Subjects</th><th>Grades / boards</th><th>Availability</th>${can('payouts.view') ? '<th class="r">Rate/hr</th>' : ''}<th class="r">Students</th><th class="r">Paid hrs this month</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((t) => `<tr><td><b>${esc(t.name)}</b><div class="small muted">${esc(t.country)} · ${esc(t.currency)}</div></td><td>${esc(t.subjects || '')}</td><td class="small">${esc(t.grades || '')}<div class="muted">${esc(t.boards || '')}</div></td>
        <td class="small">${esc(t.availability || '')}</td>${can('payouts.view') ? `<td class="r num">${money(t.rate_per_hour, t.currency)}</td>` : ''}<td class="r num">${t.active_students}</td><td class="r num">${t.month_hours}</td><td>${pill(t.status)}</td>
        <td class="r">${can('teachers.edit') ? `<button class="small" data-edit="${t.id}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`);
    $('#nt') && ($('#nt').onclick = () => teacherModal());
    $$('[data-edit]').forEach((b) => { b.onclick = () => teacherModal(rows.find((t) => String(t.id) === b.dataset.edit)); });
  }

  // ---------------- accounts ----------------
  async function pageAccounts() {
    const p = qs();
    const tab = p.tab || 'payments';
    const month = p.month || new Date().toISOString().slice(0, 7);
    const head = `<div class="page-head"><div><h1>Accounts</h1></div>${can('dashboard.team') ? '<div class="actions"><button id="exp">Export payments CSV</button></div>' : ''}</div>
      <nav class="views">${[['payments', 'All payments'], ['due', 'Instalments due'], ['refunds', 'Refunds'], ...(can('expenses.edit') ? [['expenses', 'Expenses']] : []), ...(can('reports.finance') ? [['report', 'Monthly report']] : [])]
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
      const query = tab === 'due' ? '?due=3' : tab === 'refunds' ? '' : '';
      let rows = await get(`/payments${query}`);
      if (tab === 'refunds') rows = rows.filter((x) => x.status.startsWith('Refund'));
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
    const month = p.month || new Date().toISOString().slice(0, 7);
    const [rows, live, rec] = await Promise.all([get(`/payouts?month=${month}`), get(`/payouts/live?month=${month}`), get(`/payouts/reconcile?month=${month}`)]);
    const mism = rec.filter((r) => r.mismatch);
    setPage(`<div class="page-head"><div><h1>Teacher payouts</h1><div class="muted">Built from attendance: only classes that qualify for pay</div></div>
      <div class="actions">${can('payouts.adjust') ? '<button class="primary" id="gen">Generate statements</button>' : ''}</div></div>
      <form class="filters" id="pf"><input type="month" name="month" value="${month}"><button>Show month</button></form>
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
    $('#pf').onsubmit = (e) => { e.preventDefault(); location.hash = `#/payouts?month=${e.target.month.value}`; };
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
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Market</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(S.meta.roles[u.role])}</td><td>${esc(u.market || '—')}</td><td>${u.active ? pill('Active') : pill('Inactive')}</td><td class="r"><button class="small" data-u="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>
      <div class="panel" style="margin-top:16px"><h2>What each role can do</h2><dl class="fields">
        <dt>Sales Executive</dt><dd>Own leads, log calls and WhatsApp, follow-ups, KYC capture, convert, retention follow-ups. Cannot assign teachers, see payouts or edit attendance.</dd>
        <dt>Sales Manager</dt><dd>All leads, reassign, approve instalment plans and refunds, team dashboard. Cannot edit payouts.</dd>
        <dt>Admin / Ops</dt><dd>Verify KYC, student stages, teacher assignment, schedules, attendance, payout adjustments. Cannot delete lead history.</dd>
        <dt>Accounts</dt><dd>Payments, invoices, refunds processing, expenses, payout approval and payment. Cannot edit lead stages.</dd>
        <dt>Owner</dt><dd>Everything, including unlocking paid payout months.</dd></dl></div>`);
    $('#nu').onclick = () => userModal();
    $('#run').onclick = async () => { const r = await post('/automation/run'); toast(`Automation ran: ${r.leadRules.reassigned} reassigned, ${r.followUps} reminders`); };
    $$('[data-u]').forEach((b) => { b.onclick = () => userModal(rows.find((u) => String(u.id) === b.dataset.u)); });
  }

  setInterval(() => { if (S.me) refreshBell(); }, 60000);
  boot();
})();
