// Printable invoice / receipt and teacher payout statement (browser "Save as PDF").
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, c) => `${c} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const BRAND = process.env.BRAND_NAME || 'Jeta Edu';

const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1b1f24;max-width:760px;margin:40px auto;padding:0 24px}
h1{font-size:22px;margin:0}.muted{color:#667085}.row{display:flex;justify-content:space-between;gap:24px;margin:24px 0}
table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e4e7ec}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#667085}td.n,th.n{text-align:right}
.total td{font-weight:700;border-top:2px solid #1b1f24}.badge{display:inline-block;padding:2px 10px;border-radius:99px;background:#ecfdf3;color:#067647;font-weight:600;font-size:12px}
.badge.pending{background:#fffaeb;color:#b54708}@media print{.noprint{display:none}}
</style></head><body>${body}<p class="noprint" style="margin-top:40px"><button onclick="print()">Print / Save as PDF</button></p></body></html>`;

function invoice(p) {
  const paid = ['Paid', 'Partial'].includes(p.status);
  return shell(`${p.invoice_no}`, `
  <div class="row"><div><h1>${esc(BRAND)}</h1><div class="muted">${paid ? 'Receipt' : 'Invoice'} ${esc(p.invoice_no)}</div></div>
  <div style="text-align:right"><span class="badge ${paid ? '' : 'pending'}">${esc(p.status)}</span><div class="muted">${esc((p.paid_at || p.created_at || '').slice(0, 10))}</div></div></div>
  <div class="row"><div><div class="muted">Billed to</div><strong>${esc(p.parent_name)}</strong><br>${esc(p.email || '')}<br>${esc(p.city || '')}</div>
  <div><div class="muted">Student</div><strong>${esc(p.child_name)}</strong></div></div>
  <table><tr><th>Description</th><th class="n">Hours</th><th class="n">Amount</th></tr>
  <tr><td>${esc(p.kind || 'Tuition')} package – ${esc(p.subjects || '')}${p.instalment_no > 1 ? ` (instalment ${p.instalment_no})` : ''}</td><td class="n">${esc(p.hours ?? '')}</td><td class="n">${fmt(p.amount, p.currency)}</td></tr>
  <tr class="total"><td colspan="2">Total</td><td class="n">${fmt(p.amount, p.currency)}</td></tr></table>
  ${paid ? `<p class="muted">Paid via ${esc(p.method)} · Ref ${esc(p.reference)}</p>` : `<p class="muted">Due ${esc(p.due_date || 'on receipt')}</p>`}`);
}

function statement(p) {
  const rows = p.lines.map((l) => `<tr><td>${esc(l.student)}${l.demo ? ' (demo)' : ''}</td><td>${esc(l.subject)}</td><td class="n">${l.hours}</td><td class="n">${fmt(l.rate, p.currency)}</td><td class="n">${fmt(l.gross, p.currency)}</td></tr>`).join('');
  return shell(`Payout ${p.teacher_name} ${p.month}`, `
  <div class="row"><div><h1>${esc(BRAND)}</h1><div class="muted">Teacher payout statement · ${esc(p.month)}</div></div>
  <div style="text-align:right"><span class="badge ${p.status === 'Paid' ? '' : 'pending'}">${esc(p.status)}</span></div></div>
  <div><strong>${esc(p.teacher_name)}</strong> · ${esc(p.country)} · ${esc(p.currency)}</div>
  <table><tr><th>Student</th><th>Subject</th><th class="n">Hours</th><th class="n">Rate/hr</th><th class="n">Gross</th></tr>${rows}
  <tr><td colspan="4">Gross</td><td class="n">${fmt(p.gross, p.currency)}</td></tr>
  <tr><td colspan="4">Adjustments ${p.adjustment_note ? `– ${esc(p.adjustment_note)}` : ''}</td><td class="n">${fmt(p.adjustments, p.currency)}</td></tr>
  <tr class="total"><td colspan="4">Net payable</td><td class="n">${fmt(p.net, p.currency)}</td></tr></table>
  ${p.status === 'Paid' ? `<p class="muted">Paid ${esc((p.paid_at || '').slice(0, 10))} via ${esc(p.pay_mode)} · Ref ${esc(p.pay_reference)}</p>` : ''}`);
}

module.exports = { invoice, statement };
