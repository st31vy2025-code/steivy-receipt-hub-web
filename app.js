// Steivy Receipt Hub — app.js
// Features: Create/Edit/Delete worker, Add/Edit/Delete account, "Are you sure?" confirmations,
// Team-chat popups + live chat feed, Top performers / Top errors leaderboards, Error Processed, Admin edit counts,
// User agreement (accept before use), Shift tracker (Start shift / End shift from pasted Abukai stats, one running shift per account),
// Late errors (errors that appear in Abukai later are added to the last shift of the same account automatically).
// Load with: <script type="module" src="app.js"></script>

let firebaseConfig = {};
try {
  ({ firebaseConfig } = await import('./firebase-config.js'));
} catch (e) {
  console.warn('firebase-config.js not found or invalid; running in demo mode.', e);
}

const isSet = v => !!v && !String(v).startsWith('YOUR_');
const configured = isSet(firebaseConfig?.apiKey) && isSet(firebaseConfig?.projectId);

/* ───────────────────────── State ───────────────────────── */
let auth, db, fb = {};
let currentUser = null, profile = null;
let page = 'dashboard';
let unsubs = [];
let authToken = 0;
let pendingRender = false;
let detailId = null;
let chatReady = false, unreadChat = 0;
let theme = 'light';
let lbPeriod = 'month', lbError = false, lbTimer = null;
let perfView = 'top'; // admin dashboard: 'top' (Top 5 lists) or 'totals' (every worker)
let loaded = {};
let accessErr = {}; // collections the admin could not read (permission-denied)
let missedFrom = '', missedTo = '';
let chatConv = 'group', dmWith = '', dmUnsub = null, dmReady = false; // chat: 'group' (public) or 'dm' (private worker <-> admin)
let auditUnsub = null, auditLimit = 50, auditMore = false, subLimit = 50;
let trackerErr = false; // could not read /activeShifts (Firestore rules)
let peerConvs = {}, peerUnsubs = {}, peerReady = {}, peerSel = null, peerMsgUnsub = null, peerMsgs = [], peerSearch = ''; // co-worker private chat
const filters = { q: '', status: 'all', from: '', to: '' };
const DEFAULT_SETTINGS = { grossRateCents: 100, deductionPercent: 10, errorWarnPercent: 5, workUrl: '' };
const CHAT_LIMIT = 30; // messages loaded per conversation (keeps reads small)
const WORKER_SUB_MONTHS = 2; // workers load only this many months of their OWN submissions (current + previous); older months of "All time" come from /leaderboard
let workerSubsWindowed = true; // false if the Firestore index is missing and the full query is used instead
const SUB_WINDOW_MONTHS = 3; // admin loads only submissions of this many months (current + previous) to save Firestore reads
let presenceDocs = {}; // worker: one /presence doc listener per co-worker, active only on the Co-workers page
let shiftDocs = {};    // worker: one /activeShifts doc listener per assigned account
let statsDocs = {}, statsMonth = '', statsErr = false, statsTimer = null; // per-account totals: worker listeners (Co-workers page only) + admin sync timer
let watchConvs = [], watchSel = null, watchMsgs = [], watchUnsub = null, watchMsgUnsub = null, watchSearch = '', watchSeen = null, watchReady = false; // admin: monitor + reply in co-worker chats (watchSeen = when I last read each chat, kept in this browser)
const data = { submissions: [], accounts: [], users: [], messages: [], presence: [], announcements: [], annRead: [], leaderboard: [], accountStats: [], audit: [], threads: [], dmMessages: [], activeShifts: [], settings: { ...DEFAULT_SETTINGS } };

/* ───────────────────────── Helpers ───────────────────────── */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = n => (n || 'U').trim().split(/\s+/).slice(0, 2).map(x => x[0] || '').join('').toUpperCase();
const pesoFmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 2 });
const money = cents => pesoFmt.format((Number(cents) || 0) / 100);
const num = v => Number(v) || 0;
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

function toDate(d) {
  if (!d) return null;
  if (d.toDate) return d.toDate();
  if (d instanceof Date) return isNaN(d) ? null : d;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day); // local date, avoids UTC day shift
  }
  const x = new Date(d);
  return isNaN(x) ? null : x;
}
const date = d => {
  const x = toDate(d);
  return x ? x.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
};
const fmtTime = d => {
  const x = toDate(d);
  return x ? x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
};
const todayStr = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
};
// Pending serverTimestamp() values are null locally: treat them as "now".
const timeVal = v => {
  if (!v) return Date.now();
  if (v.toMillis) return v.toMillis();
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
};
const rate = () => num(data.settings.grossRateCents ?? DEFAULT_SETTINGS.grossRateCents);
const dedPct = () => num(data.settings.deductionPercent ?? DEFAULT_SETTINGS.deductionPercent);

/* ───────────────────────── Shift schedule ───────────────────────── */
const SHIFT_OPTIONS = [
  { id: 'n1', label: '6:00 PM – 2:00 AM', from: '18:00', to: '02:00' },
  { id: 'n2', label: '2:00 AM – 10:00 AM', from: '02:00', to: '10:00' },
  { id: 'd1', label: '10:00 AM – 6:00 PM', from: '10:00', to: '18:00' },
  { id: 'long', label: '6:00 PM – 10:00 AM', from: '18:00', to: '10:00' },
  { id: 'open', label: '24h / Open shift', from: '', to: '' },
  { id: 'custom', label: 'Custom time (from – to)', from: '', to: '' },
  { id: 'none', label: 'No schedule (no time limit)', from: '', to: '' }
];
const toMin = t => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fmt12 = t => { const [h, m] = String(t).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
// Returns { type, from, to, open, label } or null when the user has no schedule.
function scheduleOf(u) {
  const s = u?.shiftSchedule;
  if (!s || !s.type || s.type === 'none') return null;
  if (s.type === 'open') return { type: 'open', open: true, label: '24h / Open shift' };
  const opt = SHIFT_OPTIONS.find(o => o.id === s.type);
  const from = s.type === 'custom' ? s.from : opt?.from;
  const to = s.type === 'custom' ? s.to : opt?.to;
  if (!from || !to) return null;
  return { type: s.type, from, to, open: false, label: `${fmt12(from)} – ${fmt12(to)}${s.type === 'custom' ? ' (custom)' : ''}` };
}
// True when "now" is inside the scheduled window (overnight windows such as 6 PM – 2 AM are handled).
function inWindow(sc, now = new Date()) {
  if (!sc || sc.open) return true;
  const n = now.getHours() * 60 + now.getMinutes(), a = toMin(sc.from), b = toMin(sc.to);
  if (a === b) return true;
  return a < b ? (n >= a && n <= b) : (n >= a || n <= b);
}
// After midnight in an overnight shift the shift belongs to the previous calendar day.
function defaultShiftDate(sc) {
  const d = new Date();
  if (sc && !sc.open) {
    const a = toMin(sc.from), b = toMin(sc.to), n = d.getHours() * 60 + d.getMinutes();
    if (a > b && n <= b) d.setDate(d.getDate() - 1);
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftNoticeHtml(sc, ok) {
  if (!sc) return `<div class="notice" style="margin-bottom:12px">No shift schedule assigned yet. Ask your administrator to set your schedule.</div>`;
  if (sc.open) return `<div class="notice" style="margin-bottom:12px">🕒 Your schedule: <b>${esc(sc.label)}</b>. You can submit anytime.</div>`;
  return ok
    ? `<div class="notice" style="margin-bottom:12px">🕒 Your schedule: <b>${esc(sc.label)}</b>. You can submit now.</div>`
    : `<div class="notice warn" style="margin-bottom:12px">⛔ Your schedule: <b>${esc(sc.label)}</b>. You can only start and end your shift (total output and errors) during this time. If you do not submit within your schedule, your pay will be void.</div>`;
}
// Keeps the shift tracker in step with the clock without re-rendering (so typed values are not lost).
function refreshShiftGate() {
  if (!currentUser || !profile || isAdmin()) return;
  const el = $('#shiftGate');
  if (!el) return;
  const sc = scheduleOf(profile), ok = inWindow(sc);
  if (el.dataset.ok !== String(ok)) { el.dataset.ok = String(ok); el.innerHTML = shiftNoticeHtml(sc, ok); }
  $$('[data-start-shift]').forEach(b => { if (b.dataset.busy !== '1') b.disabled = !ok; });
  const b = $('#submissionForm [type=submit]');
  if (b && b.dataset.noacct !== '1') b.disabled = !ok;
}
setInterval(refreshShiftGate, 30000);

// Shown to every worker each time they sign in / open the app.
function showShiftWarning() {
  $('#shiftWarn')?.remove();
  if (!currentUser || !profile || isAdmin()) return;
  const sc = scheduleOf(profile);
  const wrap = document.createElement('div');
  wrap.className = 'sh-modal';
  wrap.id = 'shiftWarn';
  wrap.innerHTML = `<div class="sh-modal-card sh-confirm" role="alertdialog" aria-modal="true"><div class="sh-confirm-ico danger">⚠️</div><h3>Don't forget!</h3><p>Press <b>End shift</b> (paste your Abukai stats) before your shift ends.</p>${sc ? `<p class="muted">Your shift: <b>${esc(sc.label)}</b></p>` : ''}<p style="color:#c0392b;font-weight:600;margin-top:8px">If you cannot submit within your scheduled time, your salary will be void.</p><div class="sh-modal-actions"><button type="button" class="btn btn-primary" data-ok>I understand</button></div></div>`;
  document.body.appendChild(wrap);
  const ok = wrap.querySelector('[data-ok]');
  ok.addEventListener('click', () => wrap.remove());
  ok.focus();
}

/* ───────────────────────── Audit log, reminders, missed shifts, error rate ───────────────────────── */
const errWarnPct = () => num(data.settings.errorWarnPercent ?? DEFAULT_SETTINGS.errorWarnPercent);
// Link to the work website. It is stored in Firestore (Pay settings), only http(s) links are accepted.
const workUrl = () => { const u = String(data.settings.workUrl || '').trim(); return /^https?:\/\//i.test(u) ? u : ''; };
// "Processed" is the total submitted receipts and already INCLUDES the receipts with errors, so rate = errors ÷ processed.
const errRatePct = (p, e) => (num(p) > 0 ? num(e) / num(p) * 100 : 0);
const liveUsers = () => data.users.filter(u => u.status !== 'deleted'); // deleted workers are kept only as hidden tombstones
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + off); return ymd(d); };
const rowAdminBtns = s => `<button class="small-btn" data-edit-counts="${esc(s.id)}">Edit counts</button>${s.status !== 'rejected' ? `<button class="small-btn" data-allow-resubmit="${esc(s.id)}">Allow resubmit</button>` : ''}`;

// Records an admin action. Never blocks the action itself if the write fails.
async function logAudit(action, details = '') {
  if (!currentUser || !profile) return;
  const item = { action, details: String(details).slice(0, 600), actorId: currentUser.uid, actorName: profile.displayName || currentUser.email || 'Admin' };
  if (!configured) { data.audit.unshift({ ...item, id: 'local-' + Date.now(), createdAt: new Date() }); return; }
  try {
    await fb.addDoc(fb.collection(db, 'auditLogs'), { ...item, createdAt: fb.serverTimestamp() });
  } catch (e) { console.warn('audit log write failed (check Firestore rules for /auditLogs)', e); }
}

// Admin: keeps /accountLast in step when the last shift of an account is edited or voided.
async function patchAccountLast(subId, accountId, patch) {
  if (!configured || !accountId) return;
  try {
    const ref = fb.doc(db, 'accountLast', accountId);
    const snap = await fb.getDoc(ref);
    if (snap.exists() && snap.data().submissionId === subId) {
      await fb.updateDoc(ref, { ...patch, updatedAt: fb.serverTimestamp() });
    }
  } catch (e) { console.warn('accountLast sync failed', e); }
}

// 30-minute reminder before the shift ends (only for workers who still have an account without a submission)
function showShiftReminder(mins, sc, names) {
  $('#shiftRemind')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'sh-modal';
  wrap.id = 'shiftRemind';
  wrap.innerHTML = `<div class="sh-modal-card sh-confirm" role="alertdialog" aria-modal="true"><div class="sh-confirm-ico danger">⏰</div><h3>${mins} minute(s) left in your shift</h3><p>Press <b>End shift</b> (paste your Abukai stats) for:</p><p><b>${names.map(esc).join(', ')}</b></p><p class="muted">Shift: ${esc(sc.label)}</p><p style="color:#c0392b;font-weight:600;margin-top:8px">No submission within your schedule means your salary will be void.</p><div class="sh-modal-actions"><button type="button" class="btn btn-ghost" data-later>Later</button><button type="button" class="btn btn-primary" data-go>End shift now</button></div></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('[data-later]').addEventListener('click', () => wrap.remove());
  wrap.querySelector('[data-go]').addEventListener('click', () => { wrap.remove(); go('receipts'); });
}
function checkShiftReminder() {
  if (!currentUser || !profile || isAdmin()) return;
  if (configured && !loaded.submissions) return;
  const sc = scheduleOf(profile);
  if (!sc || sc.open || !inWindow(sc)) return;
  const a = toMin(sc.from), b = toMin(sc.to);
  if (a === b) return;
  const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
  const remaining = a < b ? b - nm : (nm >= a ? (1440 - nm) + b : b - nm);
  if (remaining < 0 || remaining > 30) return;
  const day = defaultShiftDate(sc);
  const done = new Set(data.submissions.filter(s => s.status !== 'rejected' && s.workerId === currentUser.uid && s.shiftDate === day).map(s => s.accountId));
  const missing = data.accounts.filter(x => x.isActive !== false && (!x.assignedWorkerIds || x.assignedWorkerIds.includes(currentUser.uid)) && !done.has(x.id));
  if (!missing.length) return;
  const key = `steivy_remind_${currentUser.uid}_${day}`;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); }
  catch { if (window.__shiftRemindKey === key) return; window.__shiftRemindKey = key; }
  showShiftReminder(Math.max(1, remaining), sc, missing.map(x => x.name));
}
setInterval(checkShiftReminder, 30000);

/* ───────────────────────── Offline banner ─────────────────────────
   Pure browser events (online/offline): no Firebase calls, no polling. Lives on <body>, outside #app,
   so page re-renders never remove it. */
let netTimer = null;
function netBanner(state) {
  let el = $('#netBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'netBanner';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  clearTimeout(netTimer);
  el.className = state;
  el.textContent = state === 'off' ? 'You are offline. Changes may not save until your connection is back.' : 'Back online.';
  if (state === 'on') netTimer = setTimeout(() => el.remove(), 2500);
}
window.addEventListener('offline', () => netBanner('off'));
window.addEventListener('online', () => { if ($('#netBanner')) netBanner('on'); });
if (navigator.onLine === false) window.addEventListener('DOMContentLoaded', () => netBanner('off'), { once: true });

// Missed shift report: a scheduled worker with no non-rejected submission for an ended shift, per assigned account.
function shiftEndAt(sc, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (sc.open) return new Date(y, m - 1, d + 1, 0, 0, 0);
  const a = toMin(sc.from), b = toMin(sc.to);
  return new Date(y, m - 1, d + (a >= b ? 1 : 0), Math.floor(b / 60), b % 60, 59);
}
function eachDay(from, to) {
  const out = [];
  if (!from || !to) return out;
  const [y, m, d] = from.split('-').map(Number), [y2, m2, d2] = to.split('-').map(Number);
  const cur = new Date(y, m - 1, d), end = new Date(y2, m2 - 1, d2);
  while (cur <= end && out.length < 62) { out.push(ymd(cur)); cur.setDate(cur.getDate() + 1); }
  return out;
}
function missedShifts(from, to) {
  if (configured && !loaded.submissions) return [];
  const now = new Date(), out = [];
  const have = new Set(data.submissions.filter(s => s.status !== 'rejected').map(s => `${s.workerId}|${s.accountId}|${s.shiftDate}`));
  liveUsers().filter(w => w.role === 'worker' && w.isActive !== false && (w.status || 'approved') === 'approved').forEach(w => {
    const sc = scheduleOf(w);
    if (!sc) return;
    const since = w.shiftSchedule?.since || todayStr();
    const accts = data.accounts.filter(a => a.isActive !== false && (a.assignedWorkerIds || []).includes(w.id));
    eachDay(from, to).forEach(day => {
      if (day < since) return;
      const endsAt = shiftEndAt(sc, day);
      if (endsAt > now) return;
      accts.forEach(a => {
        if (!have.has(`${w.id}|${a.id}|${day}`)) out.push({ date: day, workerId: w.id, worker: w.displayName || w.email || 'Worker', account: a.name, label: sc.label, endsAt });
      });
    });
  });
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.worker.localeCompare(b.worker));
}
function missedNotice() {
  const n = missedShifts(dayStr(-6), todayStr()).length;
  return n ? `<br><b>${n}</b> missed shift(s) in the last 7 days. <button class="small-btn" data-page="missed">View report</button>` : '';
}

// Error-rate warning (limit is set by the admin in Pay settings)
function errorWarningPanel() {
  const lim = errWarnPct();
  if (lim <= 0) return '';
  if (isAdmin()) {
    const list = rankings('month').rows.map(r => ({ ...r, rate: errRatePct(r.receipts, r.errors) })).filter(r => r.errors > 0 && r.rate >= lim).sort((a, b) => b.rate - a.rate);
    if (!list.length) return '';
    const bar = rt => `<div class="alert-bar" title="Limit ${lim}%"><i style="width:${Math.min(100, rt * 50 / lim).toFixed(1)}%"></i><u></u></div>`;
    const rowsHtml = list.slice(0, 8).map(r => `<div class="alert-row"><div class="avatar">${esc(initials(r.name))}</div><div class="alert-who"><strong>${esc(r.name)}</strong><small>${r.errors.toLocaleString()} error(s) of ${r.receipts.toLocaleString()} receipts</small></div>${bar(r.rate)}<b class="alert-rate">${r.rate.toFixed(1)}%</b></div>`).join('');
    return `<div class="alert-card" role="alert"><div class="alert-head"><span class="alert-ico">!</span><div><h3>High error rate this month</h3><p>${list.length} worker(s) at or above the ${lim}% limit · approved shifts only</p></div><span class="alert-pill">Limit ${lim}%</span></div><div class="alert-list">${rowsHtml}</div>${list.length > 8 ? `<div class="alert-more">+ ${list.length - 8} more worker(s)</div>` : ''}</div>`;
  }
  const key = monthKeyOf(0);
  const rows = visibleSubmissions().filter(s => s.status === 'approved' && monthOf(s) === key);
  const p = rows.reduce((n, s) => n + num(s.receiptCount), 0), e = rows.reduce((n, s) => n + num(s.errorCount), 0);
  const rt = errRatePct(p, e);
  if (e === 0 || rt < lim) return '';
  return `<div class="alert-card" role="alert"><div class="alert-head"><span class="alert-ico">!</span><div><h3>Your error rate is above the limit</h3><p>This month · approved shifts only</p></div><span class="alert-pill">Limit ${lim}%</span></div><div class="alert-me"><div class="alert-big">${rt.toFixed(1)}%</div><div class="alert-me-body"><div class="alert-bar" title="Limit ${lim}%"><i style="width:${Math.min(100, rt * 50 / lim).toFixed(1)}%"></i><u></u></div><small>${e.toLocaleString()} error(s) out of ${p.toLocaleString()} receipts. Please double-check each receipt before submitting.</small></div></div></div>`;
}

function missedPage() {
  const to = missedTo || todayStr(), from = missedFrom || dayStr(-6);
  const list = missedShifts(from, to);
  const people = new Set(list.map(x => x.workerId)).size;
  const rows = list.map(x => `<tr><td>${esc(date(x.date))}</td><td><div class="person"><div class="avatar">${esc(initials(x.worker))}</div><strong>${esc(x.worker)}</strong></div></td><td>${esc(x.account)}</td><td>${esc(x.label)}</td><td>${esc(date(x.endsAt))} ${esc(fmtTime(x.endsAt))}</td></tr>`).join('')
    || `<tr><td colspan="5"><div class="empty"><span class="empty-ico">${EMPTY_ICONS.check}</span><b>No missed shifts</b>Every scheduled worker submitted for this period.</div></td></tr>`;
  return `<div class="welcome"><div><h2>Missed shifts</h2><p>Scheduled workers who did not submit total output and errors for their shift.</p></div></div><div class="stats">${stat('Missed shifts', list.length, `${esc(from)} to ${esc(to)}`, '⏱')}${stat('Workers affected', people, 'Unique workers', '♙')}</div><div class="panel"><div class="toolbar"><label class="muted">From <input type="date" id="missedFrom" value="${esc(from)}" max="${todayStr()}"></label><label class="muted">To <input type="date" id="missedTo" value="${esc(to)}" max="${todayStr()}"></label><span class="spacer"></span><span class="muted">${list.length} record(s)</span></div><div class="table-wrap"><table><thead><tr><th>Shift date</th><th>Worker</th><th>Account</th><th>Schedule</th><th>Shift ended</th></tr></thead><tbody>${rows}</tbody></table></div><div class="notice" style="margin-top:12px">Only workers with a saved shift schedule are checked, for each account assigned to them. A schedule counts from the day it was saved. Submissions that were reset with "Allow resubmit" count as missed until the worker submits again.</div></div>`;
}

function auditPage() {
  const rows = data.audit.slice().sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt));
  const body = rows.map(a => `<tr><td>${esc(date(a.createdAt))}<small style="display:block;color:#8a958e;margin-top:4px">${esc(fmtTime(a.createdAt))}</small></td><td><strong>${esc(a.actorName || 'Admin')}</strong></td><td>${esc(a.action || '')}</td><td>${esc(a.details || '')}</td></tr>`).join('')
    || `<tr><td colspan="4"><div class="empty"><span class="empty-ico">${EMPTY_ICONS.receipts}</span><b>No activity recorded yet</b>Admin actions appear here. If nothing shows after an action, publish the latest firestore.rules.</div></td></tr>`;
  return `<div class="welcome"><div><h2>Audit log</h2><p>Who changed what, and when. Showing the latest ${rows.length} (50 at a time).</p></div></div><div class="panel"><div class="toolbar"><input id="auditSearch" placeholder="Search action, admin or details…"><span class="spacer"></span>${auditMore ? '<button type="button" class="small-btn" id="moreAudit">Load 50 more</button>' : ''}<span class="muted">${rows.length} record(s)</span></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Details</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
}

// ADMIN: void a submission so the worker can submit that shift again
async function allowResubmit(id) {
  if (!isAdmin()) return;
  const s = data.submissions.find(x => x.id === id);
  if (!s) return toast('Submission not found.');
  if (s.status === 'rejected') return toast('This shift is already open for resubmission.');
  if (!await confirmBox('Allow resubmit?', `This voids ${s.workerName || 'the worker'}'s submission for ${s.accountName || 'this account'} on ${date(s.shiftDate)} so they can submit it again. Its pay is removed until they resubmit. Continue?`, 'Yes, allow resubmit', true)) return;
  const reason = 'Reset by admin. Please submit this shift again.';
  const info = `${s.workerName || 'Worker'} · ${s.accountName || ''} · ${s.shiftDate}`;
  if (!configured) {
    Object.assign(s, { status: 'rejected', rejectionReason: reason, resubmitAllowed: true });
    detailId = null;
    logAudit('Allowed resubmit', info);
    toast('Demo: resubmit allowed.');
    renderPage();
    return;
  }
  try {
    await fb.updateDoc(fb.doc(db, 'submissions', s.id), {
      status: 'rejected', rejectionReason: reason, resubmitAllowed: true,
      reviewedBy: currentUser.uid, reviewedAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp()
    });
    await patchAccountLast(s.id, s.accountId, { open: false }); // voided: no more late errors for this shift
    detailId = null;
    $('#detailsPanel')?.remove();
    logAudit('Allowed resubmit', info);
    toast('Resubmit allowed. The worker can submit this shift again.');
  } catch (e) { console.error(e); toast('Could not update submission. Check Firestore rules.'); }
}

let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
function unlisten() { unsubs.forEach(fn => { try { fn(); } catch {} }); unsubs = []; stopDm(); stopAudit(); stopPeer(); stopPresenceListen(); stopShiftDocs(); stopStatsListen(); stopWatch(); }
function startPresenceListen() {
  if (!configured || !db || !currentUser || isAdmin()) return;
  const { doc, onSnapshot } = fb;
  const uid = currentUser.uid;
  // The rules let a worker read /presence/{uid} one document at a time (co-workers on a shared account), never the whole collection.
  const want = new Set();
  data.accounts.forEach(a => (a.assignedWorkerIds || []).forEach(id => { if (id !== uid) want.add(id); }));
  Object.keys(presenceDocs).forEach(id => {
    if (want.has(id)) return;
    try { presenceDocs[id](); } catch {}
    delete presenceDocs[id];
    data.presence = data.presence.filter(p => p.id !== id);
  });
  want.forEach(id => {
    if (presenceDocs[id]) return;
    presenceDocs[id] = onSnapshot(doc(db, 'presence', id), s => {
      presenceReadErr = false;
      data.presence = data.presence.filter(p => p.id !== id);
      if (s.exists()) data.presence.push({ id: s.id, ...s.data() });
      updateOnline();
    }, err => {
      console.warn('presence listener (check Firestore rules for /presence)', err);
      presenceReadErr = true;
      updateOnline();
    });
  });
}
function stopPresenceListen() { Object.values(presenceDocs).forEach(f => { try { f(); } catch {} }); presenceDocs = {}; }

// Worker: running shifts are read one account document at a time (the rules only allow a collection query for the admin).
function syncShiftListeners() {
  if (!configured || !db || !currentUser || isAdmin()) return;
  const { doc, onSnapshot } = fb;
  const want = new Set(data.accounts.map(a => a.id)); // the accounts query already returns only my assigned accounts
  Object.keys(shiftDocs).forEach(id => {
    if (want.has(id)) return;
    try { shiftDocs[id](); } catch {}
    delete shiftDocs[id];
    data.activeShifts = data.activeShifts.filter(x => x.id !== id);
  });
  want.forEach(id => {
    if (shiftDocs[id]) return;
    shiftDocs[id] = onSnapshot(doc(db, 'activeShifts', id), s => {
      trackerErr = false;
      data.activeShifts = data.activeShifts.filter(x => x.id !== id);
      if (s.exists()) data.activeShifts.push({ id: s.id, ...s.data() });
      loaded.activeShifts = true;
      requestRender();
    }, err => {
      console.warn('activeShifts listener (check Firestore rules for /activeShifts)', err);
      trackerErr = true;
      requestRender();
    });
  });
  if (!want.size) { loaded.activeShifts = true; requestRender(); }
}
function stopShiftDocs() { Object.values(shiftDocs).forEach(f => { try { f(); } catch {} }); shiftDocs = {}; }

const isAdmin = () => profile?.role === 'admin';
const visibleSubmissions = () => isAdmin() ? data.submissions : data.submissions.filter(s => s.workerId === currentUser?.uid);

// Runs many Firestore writes in batches of 400 (Firestore limit is 500 per batch).
async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = fb.writeBatch(db);
    ops.slice(i, i + 400).forEach(f => f(b));
    await b.commit();
  }
}

/* Extra styles so no CSS file change is needed */
const extraStyle = document.createElement('style');
extraStyle.textContent = `
.hidden{display:none!important}
button:disabled{opacity:.6;cursor:not-allowed}
.sh-modal{position:fixed;inset:0;background:rgba(15,23,20,.5);display:flex;align-items:center;justify-content:center;padding:16px;z-index:1000}
.sh-modal-card{background:#fff;color:#1a2420;border-radius:16px;padding:24px;width:100%;max-width:480px;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.25)}
.sh-modal-card h3{margin:0 0 14px}
.sh-modal-card textarea{width:100%;min-height:90px;box-sizing:border-box}
.sh-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.sh-check{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #eee;cursor:pointer}
.sh-row-actions{display:flex;gap:6px;flex-wrap:wrap}
.trk-row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:14px 0;border-top:1px solid var(--line,#eee)}
.trk-info{min-width:0;flex:1 1 220px}
.trk-info small{display:block;color:#8a958e;margin-top:4px;line-height:1.4}
.trk-live{display:inline-flex;align-items:center;gap:6px;background:#e6f6ec;color:#1e8449;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700}
.trk-free{display:inline-flex;align-items:center;gap:6px;background:#f1f4f2;color:#52605a;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700}
.online-panel{padding:14px 18px;margin-bottom:16px}
.online-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:14px}
.online-count{background:#e6f6ec;color:#1e8449;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700}
.online-empty{color:#8a958e;font-size:13px}
.online-marquee{overflow:hidden;white-space:nowrap;-webkit-mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent);mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent)}
.online-track{display:flex;width:max-content;animation:onlineScroll 20s linear infinite}
.online-marquee:hover .online-track{animation-play-state:paused}
.online-set{display:flex;gap:10px;padding-right:10px;min-width:600px}
.online-chip{display:inline-flex;align-items:center;gap:8px;background:#f1f8f4;border:1px solid #d5ecdd;border-radius:999px;padding:6px 14px;font-size:13px;font-weight:600;color:#1a2420}
.online-dot{width:9px;height:9px;border-radius:50%;background:#2ecc71;box-shadow:0 0 0 0 rgba(46,204,113,.6);animation:onlinePulse 1.8s infinite}
@keyframes onlineScroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@keyframes onlinePulse{0%{box-shadow:0 0 0 0 rgba(46,204,113,.6)}70%{box-shadow:0 0 0 8px rgba(46,204,113,0)}100%{box-shadow:0 0 0 0 rgba(46,204,113,0)}}
@media (prefers-reduced-motion:reduce){.online-track{animation:none}.online-marquee{overflow-x:auto}}
#annPopup{z-index:1100}
.ann-badge{display:inline-block;background:#fff4d6;color:#8a5a00;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;margin-bottom:10px}
.ann-body{white-space:pre-wrap;line-height:1.55;margin:10px 0 14px;word-break:break-word}
/* confirm dialog */
#confirmBox{z-index:1300}
#shiftWarn{z-index:1250}
#shiftRemind{z-index:1260}
.start-work{display:flex;align-items:center;justify-content:center;gap:8px;margin:14px 12px 0;text-decoration:none;text-align:center}
.sidebar{overflow-y:auto}
.chat-list{overflow-y:auto;max-height:70vh}
.chat-list button{position:relative}
.chat-list .nav-badge{margin-left:auto}
.sh-confirm{max-width:400px;text-align:center}
.sh-confirm p{margin:0 0 4px;line-height:1.5}
.sh-confirm .sh-modal-actions{justify-content:center}
.sh-confirm-ico{width:56px;height:56px;border-radius:50%;background:#e8f1ff;display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 12px}
.sh-confirm-ico.danger{background:#fdecea}
/* chat popups + live feed */
#chatPopups{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:10px;z-index:1200;width:min(340px,calc(100vw - 32px))}
.chat-pop{display:flex;gap:12px;align-items:flex-start;background:#fff;color:#1a2420;border-radius:14px;padding:12px 14px;box-shadow:0 12px 34px rgba(0,0,0,.22);border-left:5px solid #2ecc71;cursor:pointer;animation:popIn .35s ease}
.chat-pop-body{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.chat-pop-body span{font-size:14px;line-height:1.4;word-break:break-word;white-space:pre-wrap}
.chat-pop-body small{color:#8a958e;font-size:11px}
.chat-pop-x{border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#8a958e}
@keyframes popIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}
@keyframes bubbleIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.chat-messages .bubble:last-child{animation:bubbleIn .3s ease}
.nav-badge{margin-left:auto;background:#e74c3c;color:#fff;border-radius:999px;font-size:11px;font-weight:700;padding:2px 7px;min-width:18px;text-align:center}
.live-chat{max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth;padding-right:4px}
.live-msg{display:flex;gap:10px;align-items:flex-start}
.live-msg.fresh{animation:bubbleIn .45s ease}
.live-body{background:#f4f7f5;border-radius:12px;padding:8px 12px;display:flex;flex-direction:column;gap:2px;min-width:0;max-width:100%}
.live-msg.mine .live-body{background:#e6f6ec}
.live-body span{font-size:14px;line-height:1.4;word-break:break-word;white-space:pre-wrap}
.live-body small{color:#8a958e;font-size:11px}
/* leaderboard + standing */
.perf{margin-bottom:16px}
.lb-tabs{display:flex;gap:6px;flex-wrap:wrap}
.wt-wrap{max-height:440px;overflow:auto}.wt-wrap thead th{position:sticky;top:0;z-index:1;background:#fff}
.lb-tab{border:1px solid #d5ddd8;background:#fff;color:#1a2420;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer}
.lb-tab.active{background:#1e8449;border-color:#1e8449;color:#fff}
.lb-row{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line,#eee)}
.lb-rank{width:34px;text-align:center;font-size:22px;font-weight:700}
.lb-main{flex:1;min-width:0}
.lb-top{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px}
.lb-val{font-weight:700;color:#1e8449;white-space:nowrap}
.lb-val.err{color:#c0392b}
.lb-bar{height:8px;background:#edf1ee;border-radius:999px;overflow:hidden;margin-bottom:4px}
.lb-fill{height:100%;background:linear-gradient(90deg,#2ecc71,#1e8449);border-radius:999px}
.lb-fill.err{background:linear-gradient(90deg,#f5a623,#c0392b)}
.standing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.standing{display:flex;gap:14px;align-items:center;border-radius:16px;padding:18px;border:1px solid #e3e9e5;background:#fff}
.standing-ico{font-size:40px;line-height:1}
.standing b{display:block;font-size:16px;margin-bottom:4px}
.standing p{margin:0;font-size:13px;line-height:1.45;color:#52605a}
.standing.gold{background:linear-gradient(135deg,#fff8dc,#ffeaa0);border-color:#f0c93a}
.standing.silver{background:linear-gradient(135deg,#f6f7f9,#dde2e8);border-color:#b8c0ca}
.standing.bronze{background:linear-gradient(135deg,#fff1e4,#f1c9a0);border-color:#d9a06a}
.standing.danger{background:#fdecea;border-color:#f1b0a8}
.standing.warn{background:#fff4d6;border-color:#f0d487}
.standing.good{background:#e6f6ec;border-color:#a8dcb9}
.standing.info{background:#f1f8f4}
/* dashboard message ticker */
.welcome{gap:16px;flex-wrap:wrap}
.msg-ticker{flex:1;min-width:220px;display:flex;align-items:center;gap:10px;background:#f1f8f4;border:1px solid #d5ecdd;border-radius:999px;padding:8px 16px;cursor:pointer;overflow:hidden}
.msg-ticker-view{flex:1;min-width:0;overflow:hidden;white-space:nowrap;-webkit-mask-image:linear-gradient(90deg,transparent,#000 16px,#000 calc(100% - 16px),transparent);mask-image:linear-gradient(90deg,transparent,#000 16px,#000 calc(100% - 16px),transparent)}
.msg-ticker-track{display:flex;width:max-content;animation:tickerScroll 25s linear infinite}
.msg-ticker:hover .msg-ticker-track{animation-play-state:paused}
.msg-ticker-set{display:flex;gap:36px;padding-right:36px;min-width:400px}
.msg-item{font-size:13px;color:#1a2420}
.msg-item b{color:#1e8449}
@keyframes tickerScroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){.msg-ticker-track{animation:none}.msg-ticker-view{overflow-x:auto}}
/* co-worker chat */
.peer-layout .chat-list button{display:flex;align-items:center;gap:10px;text-align:left}
.peer-search{padding:8px 4px}.peer-search input{width:100%;box-sizing:border-box}
.peer-av{position:relative;flex:none}
.peer-dot{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:#b8c0ca;border:2px solid #fff}
.peer-dot.on{background:#2ecc71}
.peer-meta{min-width:0;flex:1}.peer-meta strong,.peer-meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.peer-side{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none}.peer-side small{font-size:11px;color:#8a958e}
.peer-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line,#eee)}
.peer-head>div:nth-child(2){flex:1;min-width:0}.peer-head small{display:block;color:#8a958e}
.peer-st-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#b8c0ca;margin-right:5px}.peer-st-dot.on{background:#2ecc71}
.peer-day{text-align:center;font-size:11px;color:#8a958e;margin:10px 0}
.peer-tick{margin-left:6px;font-size:11px}
.peer-window{display:flex;flex-direction:column}
@media (max-width:760px){.peer-layout{grid-template-columns:1fr!important}.peer-layout .chat-list{max-height:240px}}
/* ── chat readability (WCAG AA) ──
   The muted greys above are hardcoded (#8a958e / #78847e) and measured 2.7:1–3.9:1 on the
   light chat surfaces, below the 4.5:1 minimum for small text. These rules darken those
   tokens only; no markup or behaviour changes. Same specificity as the rules above and
   declared later, so they win. */
:root{--muted:#5d6b64;--chat-meta:#5f6d66;--chat-line:#c4cfc8}
.live-body b{color:#1a2420}
.live-body small{color:var(--chat-meta)}
.chat-pop-body small{color:var(--chat-meta)}
.chat-pop-x{color:#5f6d66}
.chat-messages .bubble{color:#1a2420}
.chat-messages .bubble b{color:#1a2420}
.chat-messages .bubble small{color:#52605a}
.chat-messages .bubble.mine small{color:#d8ece2}
.chat-messages .bubble.mine,.chat-messages .bubble.mine b{color:#fff}
.peer-meta strong,.chat-list button strong{color:#1a2420}
.peer-meta small,.peer-side small,.peer-head small,.peer-day{color:var(--chat-meta)}
.chat-compose input,.peer-search input{border-color:var(--chat-line)}
.chat-compose input::placeholder,.peer-search input::placeholder{color:#6b7873;opacity:1}
.chat-compose .btn{white-space:nowrap}
/* Dark theme. This app has no theme layer of its own — every surface is a literal #fff —
   so the switch styles the whole app, not just the chat. Applied only when
   <html data-theme="dark"> is set, so light mode keeps its exact current values. */
[data-theme="dark"]{color-scheme:dark}
[data-theme="dark"] body{background:#0f1512;color:#e8efe9}
[data-theme="dark"] .sidebar{background:#151c18;border-right-color:#28332c}
[data-theme="dark"] .brand strong{color:#e8efe9}
[data-theme="dark"] .nav button{color:#b6c2ba}
[data-theme="dark"] .nav button.active,[data-theme="dark"] .nav button:hover{background:#1e2f27;color:#8fd6ac}
[data-theme="dark"] .nav-label,[data-theme="dark"] .crumb,[data-theme="dark"] .brand small,[data-theme="dark"] .user-mini small{color:#93a29a}
[data-theme="dark"] .topbar{background:#131a16e6;border-bottom-color:#28332c}
[data-theme="dark"] .topbar h1{color:#e8efe9}
[data-theme="dark"] .main{background:#0f1512}
[data-theme="dark"] .panel,[data-theme="dark"] .stat,[data-theme="dark"] .quick,[data-theme="dark"] .login-form-side,[data-theme="dark"] .sh-modal-card{background:#171f1a;border-color:#28332c;color:#e8efe9}
[data-theme="dark"] .panel-head h3,[data-theme="dark"] .stat strong,[data-theme="dark"] .welcome h2,[data-theme="dark"] .quick strong{color:#eef4ef}
[data-theme="dark"] .muted,[data-theme="dark"] .panel-head p,[data-theme="dark"] .welcome p,[data-theme="dark"] .stat small,[data-theme="dark"] .stat-head,[data-theme="dark"] .quick small{color:#a9b6ae}
[data-theme="dark"] td{color:#dbe5de;border-bottom-color:#222c26}
[data-theme="dark"] th{color:#93a29a;border-bottom-color:#28332c}
[data-theme="dark"] .wt-wrap thead th{background:#171f1a}
[data-theme="dark"] .person small,[data-theme="dark"] .trk-info small{color:#9daba3}
[data-theme="dark"] .field label{color:#c2cec6}
[data-theme="dark"] .field input,[data-theme="dark"] .field select,[data-theme="dark"] .field textarea,[data-theme="dark"] .toolbar input,[data-theme="dark"] .toolbar select,[data-theme="dark"] .chat-compose input,[data-theme="dark"] .peer-search input,[data-theme="dark"] .sh-modal-card input,[data-theme="dark"] .sh-modal-card textarea,[data-theme="dark"] .sh-modal-card select{background:#101713;border-color:#33413a;color:#e8efe9}
[data-theme="dark"] input::placeholder,[data-theme="dark"] textarea::placeholder{color:#8d9b94;opacity:1}
[data-theme="dark"] .btn-light{background:#1e2f27;color:#9fe0b8}
[data-theme="dark"] .btn-ghost{color:#9fe0b8;border-color:#33413a}
[data-theme="dark"] .btn-danger{background:#3a1f1c;color:#f0a79f}
[data-theme="dark"] .mode-pill,[data-theme="dark"] .demo-banner{background:#1e2f27;color:#9fe0b8}
[data-theme="dark"] .notice{background:#16241c;color:#a6d9bd}
[data-theme="dark"] .notice.warn{background:#2c2411;color:#e8c877}
/* My standing / team performance cards: they had light backgrounds in dark mode, so the text was unreadable */
[data-theme="dark"] .standing{background:#171f1a;border-color:#28332c;color:#e8efe9}
[data-theme="dark"] .standing b{color:#eef4ef}
[data-theme="dark"] .standing p{color:#b9c6be}
[data-theme="dark"] .standing.gold{background:linear-gradient(135deg,#3a3213,#2b2410);border-color:#7a6620}
[data-theme="dark"] .standing.gold b{color:#ffe58a}
[data-theme="dark"] .standing.silver{background:linear-gradient(135deg,#2a2f36,#20252b);border-color:#4a5562}
[data-theme="dark"] .standing.silver b{color:#e3e8ee}
[data-theme="dark"] .standing.bronze{background:linear-gradient(135deg,#3b2a1b,#2c2016);border-color:#7a5a3a}
[data-theme="dark"] .standing.bronze b{color:#f3cfa6}
[data-theme="dark"] .standing.danger{background:#3a1f1c;border-color:#6b3530}
[data-theme="dark"] .standing.danger b{color:#f6b3ab}
[data-theme="dark"] .standing.warn{background:#2c2411;border-color:#6b5a22}
[data-theme="dark"] .standing.warn b{color:#f0d487}
[data-theme="dark"] .standing.good{background:#16301f;border-color:#2f6b45}
[data-theme="dark"] .standing.good b{color:#a6e3bc}
[data-theme="dark"] .standing.info{background:#16241c;border-color:#28332c}
[data-theme="dark"] .lb-tab{background:#1e2f27;border-color:#33413a;color:#cfe3d6}
[data-theme="dark"] .lb-tab.active{background:#1e8449;border-color:#1e8449;color:#fff}
[data-theme="dark"] .lb-bar{background:#26332b}
[data-theme="dark"] .lb-val{color:#7fd9a1}
[data-theme="dark"] .lb-val.err{color:#f08a7e}
[data-theme="dark"] .chat-list{background:#131a16;border-right-color:#28332c}
[data-theme="dark"] .chat-list button{border-bottom-color:#222c26}
[data-theme="dark"] .chat-list button.active{background:#1e2f27}
[data-theme="dark"] .chat-list button strong,[data-theme="dark"] .chat-messages .bubble b,[data-theme="dark"] .live-body b{color:#eef4ef}
[data-theme="dark"] .chat-list button small,[data-theme="dark"] .peer-meta small,[data-theme="dark"] .peer-side small,[data-theme="dark"] .peer-day,[data-theme="dark"] .live-body small,[data-theme="dark"] .chat-pop-body small,[data-theme="dark"] .chat-messages .bubble small{color:#a3b1a9}
[data-theme="dark"] .chat-messages .bubble{background:#222d27;color:#e8efe9}
[data-theme="dark"] .chat-messages .bubble.mine{background:#1f7a4d;color:#fff}
[data-theme="dark"] .chat-messages .bubble.mine small{color:#d6f0e1}
[data-theme="dark"] .live-body{background:#222d27}
[data-theme="dark"] .live-msg.mine .live-body{background:#1c3a2b}
[data-theme="dark"] .chat-pop{background:#1b241e;color:#e8efe9}
[data-theme="dark"] .avatar{background:#22322a;color:#9fe0b8}
[data-theme="dark"] .online-chip{background:#1b2a22;border-color:#2c4438;color:#dfe9e2}
[data-theme="dark"] .online-empty,[data-theme="dark"] .empty,[data-theme="dark"] .empty b{color:#a3b1a9}
[data-theme="dark"] #toast{background:#0b100d;color:#eaf3ec}
[data-theme="dark"] .demo-note{background:#2c2411;border-color:#4a3c17;color:#e8c877}
[data-theme="dark"] .msg-ticker{background:#1b2a22;border-color:#2c4438}
[data-theme="dark"] .msg-item,[data-theme="dark"] .msg-item b{color:#dfe9e2}
[data-theme="dark"] .msg-item b{color:#9fe0b8}
[data-theme="dark"] button.small-btn,[data-theme="dark"] .small-btn{color:#9fe0b8!important}
[data-theme="dark"] button.small-btn:hover,[data-theme="dark"] .small-btn:hover{color:#d2f5e0!important}`;
document.head.appendChild(extraStyle);

/* ───────────────────────── Theme (light / dark) ───────────────────────── */
// Remembered in localStorage; on a first visit the OS preference is used.
const THEME_KEY = 'steivy_theme';
function applyTheme(t) {
  theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  const b = $('#themeBtn');
  if (b) {
    const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    b.textContent = theme === 'dark' ? '☀' : '☾';
    b.title = label;
    b.setAttribute('aria-label', label);
  }
}
function toggleTheme() { applyTheme(theme === 'dark' ? 'light' : 'dark'); }
// Runs before the first paint so the page never flashes the wrong theme.
(function initTheme() {
  let t = '';
  try { t = localStorage.getItem(THEME_KEY) || ''; } catch {}
  if (!t) t = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
  theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
})();

/* ───────────────────────── Presence (who is online) ───────────────────────── */
const ONLINE_WINDOW_MS = 780000; // a worker counts as online if seen in the last 13 minutes (the heartbeat is every 10 minutes to save Firestore reads)
let heartbeatTimer = null, onlineTimer = null, lastBeatMs = 0;

const isOnlineEntry = p => !!p && (p.demo || (p.online !== false && Date.now() - timeVal(p.lastSeen) < ONLINE_WINDOW_MS));
let presenceReadErr = false, presenceWriteErr = false;
const onlineWorkers = () => data.presence
  .filter(p => isOnlineEntry(p))
  .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));

function onlineInner() {
  const list = onlineWorkers();
  const head = `<div class="online-head"><span class="online-dot"></span><b>Online now</b><span class="online-count">${list.length}</span></div>`;
  const warn = presenceReadErr ? `<div class="notice warn" style="margin-bottom:10px">Cannot read online status. Update your Firestore rules for the "presence" collection.</div>` : presenceWriteErr ? `<div class="notice warn" style="margin-bottom:10px">Your online status could not be saved. Update your Firestore rules for the "presence" collection.</div>` : '';
  if (!list.length) return head + warn + `<div class="online-empty">No one online right now.</div>`;
  const row = list.map(p => `<span class="online-chip"><i class="online-dot"></i>${esc(p.displayName || 'Worker')}${p.role === 'admin' ? ' · Admin' : ''}${p.id === currentUser?.uid ? ' (you)' : ''}</span>`).join('');
  const dur = Math.max(15, list.length * 5);
  return head + warn + `<div class="online-marquee"><div class="online-track" style="animation-duration:${dur}s"><div class="online-set">${row}</div><div class="online-set" aria-hidden="true">${row}</div></div></div>`;
}
const onlineKey = () => `${presenceReadErr ? 'R' : ''}${presenceWriteErr ? 'W' : ''}:` + onlineWorkers().map(p => p.id).join('|');
const onlineStrip = () => `<div class="panel online-panel" id="onlineStrip" data-key="${esc(onlineKey())}">${onlineInner()}</div>`;

// Updates only the online strip (no full re-render), and only when the set of online workers changed.
function updateOnline() {
  if (page === 'coworkers') updatePeerList();
  const el = $('#onlineStrip');
  if (!el) return;
  const key = onlineKey();
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = onlineInner();
}

async function beat(online = true) {
  if (!configured || !db || !currentUser || !profile) return;
  lastBeatMs = Date.now();
  try {
    await fb.setDoc(fb.doc(db, 'presence', currentUser.uid), {
      uid: currentUser.uid, displayName: profile.displayName, role: profile.role,
      online, lastSeen: fb.serverTimestamp()
    }, { merge: true });
    if (presenceWriteErr) { presenceWriteErr = false; updateOnline(); }
  } catch (e) {
    console.warn('presence write failed (check Firestore rules for /presence)', e);
    if (!presenceWriteErr) { presenceWriteErr = true; updateOnline(); }
  }
}
function startPresence() {
  clearInterval(heartbeatTimer); clearInterval(onlineTimer);
  if (!configured) return;
  presenceWriteErr = false;
  beat(true);
  heartbeatTimer = setInterval(() => { if (!document.hidden) beat(true); }, 600000); // every 10 minutes (each beat is billed as a read for every open screen)
  onlineTimer = setInterval(updateOnline, 30000);
}
function clearPresenceTimers() {
  clearInterval(heartbeatTimer); clearInterval(onlineTimer);
  heartbeatTimer = onlineTimer = null;
}
async function stopPresence() {
  clearPresenceTimers();
  await beat(false);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && heartbeatTimer && Date.now() - lastBeatMs > 120000) beat(true); });
window.addEventListener('pagehide', () => { if (heartbeatTimer) beat(false); });

/* ───────────────────────── Announcements (admin -> all users) ───────────────────────── */
const annLsKey = () => 'steivy_ann_dismissed_' + (currentUser?.uid || '');
function localDismissed() { try { return JSON.parse(localStorage.getItem(annLsKey()) || '[]'); } catch { return []; } }
const dismissedSet = () => new Set([...(data.annRead || []), ...localDismissed()]);
function pendingAnnouncements() {
  const done = dismissedSet(), uid = currentUser?.uid;
  return data.announcements
    .filter(a => a.active !== false && !done.has(a.id) && a.createdBy !== uid) // the author does not get a popup for their own post
    .sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt));
}
function closeAnnPopup() { $('#annPopup')?.remove(); }

// Shows the newest announcement the user has not closed yet. Only on the dashboard.
function syncAnnouncementPopup() {
  if (!currentUser || !profile || page !== 'dashboard') { closeAnnPopup(); return; }
  const list = pendingAnnouncements();
  if (!list.length) { closeAnnPopup(); return; }
  const a = list[0];
  const old = $('#annPopup');
  if (old && old.dataset.id === a.id && old.dataset.count === String(list.length)) return;
  closeAnnPopup();
  const wrap = document.createElement('div');
  wrap.className = 'sh-modal';
  wrap.id = 'annPopup';
  wrap.dataset.id = a.id;
  wrap.dataset.count = String(list.length);
  wrap.innerHTML = `<div class="sh-modal-card" role="dialog" aria-modal="true"><span class="ann-badge">📢 Announcement from admin</span><h3>${esc(a.title || 'Announcement')}</h3><div class="ann-body">${esc(a.message || '')}</div><small class="muted">Posted by ${esc(a.createdByName || 'Admin')} · ${esc(date(a.createdAt))} ${esc(fmtTime(a.createdAt))}</small>${list.length > 1 ? `<div><small class="muted">${list.length - 1} more announcement(s) after this one</small></div>` : ''}<div class="sh-modal-actions"><button type="button" class="btn btn-primary" data-ann-close>Got it, close</button></div></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('[data-ann-close]').addEventListener('click', () => dismissAnnouncement(a.id));
}

async function dismissAnnouncement(id) {
  try { localStorage.setItem(annLsKey(), JSON.stringify([...new Set([...localDismissed(), id])])); } catch {}
  data.annRead = [...new Set([...(data.annRead || []), id])];
  syncAnnouncementPopup(); // closes, or shows the next one
  if (!configured || !currentUser) return;
  try {
    await fb.setDoc(fb.doc(db, 'announcementReads', currentUser.uid), { dismissedIds: fb.arrayUnion(id), updatedAt: fb.serverTimestamp() }, { merge: true });
  } catch (e) { console.warn('announcementReads write failed (check Firestore rules)', e); }
}

function announcementsPanel() {
  const list = data.announcements.filter(a => a.active !== false).sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt));
  const rows = list.map(a => `<div style="display:flex;gap:12px;justify-content:space-between;align-items:flex-start;padding:12px 0;border-top:1px solid var(--line)"><div><b>${esc(a.title || 'Announcement')}</b><div class="muted" style="white-space:pre-wrap;margin:4px 0">${esc(a.message || '')}</div><small class="muted">${esc(date(a.createdAt))} ${esc(fmtTime(a.createdAt))} · ${esc(a.createdByName || 'Admin')}</small></div><button class="small-btn" data-del-announcement="${esc(a.id)}">Remove</button></div>`).join('');
  return `<div class="panel"><div class="panel-head"><div><h3>Announcements</h3><p>Posted notes pop up on every user's dashboard until they close them</p></div><button class="btn btn-primary" id="addAnnouncement">📢 Post announcement</button></div>${rows || '<div class="empty"><span class="empty-ico">${EMPTY_ICONS.announce}</span><b>No active announcements</b>Post a note to show it to all users.</div>'}</div>`;
}

function addAnnouncement() {
  if (!isAdmin()) return;
  openModal('Post announcement',
    `<div class="field"><label>TITLE (OPTIONAL)</label><input name="title" maxlength="80" placeholder="e.g. Schedule update"></div>
     <div class="field"><label>MESSAGE / NOTE</label><textarea name="message" required maxlength="1000" placeholder="Write your note for all users…"></textarea></div>
     <div class="notice">This will pop up on every user's dashboard until they close it.</div>`,
    async fd => {
      const title = String(fd.get('title') || '').trim();
      const message = String(fd.get('message') || '').trim();
      if (!message) { toast('Write a message first.'); return false; }
      const item = { title, message, active: true, createdBy: currentUser.uid, createdByName: profile.displayName };
      if (!configured) {
        data.announcements.unshift({ ...item, id: 'local-' + Date.now(), createdAt: new Date() });
        toast('Demo announcement posted (not saved online).');
        renderPage();
        return;
      }
      await fb.addDoc(fb.collection(db, 'announcements'), { ...item, createdAt: fb.serverTimestamp() });
      logAudit('Posted announcement', title || message.slice(0, 80));
      toast('Announcement posted. It will pop up for all users.');
    }, 'Post to all users');
}

async function removeAnnouncement(id) {
  if (!isAdmin()) return;
  if (!await confirmBox('Remove announcement?', 'Are you sure you want to remove this announcement? It will disappear for everyone.', 'Yes, remove', true)) return;
  if (!configured) { data.announcements = data.announcements.filter(a => a.id !== id); renderPage(); return; }
  try {
    await fb.deleteDoc(fb.doc(db, 'announcements', id));
    logAudit('Removed announcement', id);
    toast('Announcement removed.');
  } catch (e) { console.error(e); toast('Could not remove announcement. Check Firestore rules.'); }
}

// Last month / this month processed receipts and errors for the dashboard (rejected excluded)
function monthStats(rows) {
  const cur = monthKeyOf(0), prev = monthKeyOf(-1);
  const sum = key => rows
    .filter(s => s.status === 'approved' && monthOf(s) === key)
    .reduce((t, s) => ({ r: t.r + num(s.receiptCount), e: t.e + num(s.errorCount) }), { r: 0, e: 0 });
  const p = sum(prev), c = sum(cur);
  const pre = isAdmin() ? 'Team · ' : '';
  return `<div class="stats">${stat('Last month processed', p.r.toLocaleString(), esc(pre + monthLabel(prev)), '◀')}${stat('Last month errors', p.e.toLocaleString(), esc(pre + monthLabel(prev)), '⚠')}${stat('This month processed', c.r.toLocaleString(), esc(pre + monthLabel(cur)), '▧')}${stat('This month errors', c.e.toLocaleString(), esc(pre + monthLabel(cur)), '⚠')}</div>`;
}

/* ───────────────────────── Modal + Confirm ───────────────────────── */
function closeModal() { $('#shModal')?.remove(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function openModal(title, bodyHtml, onSubmit, submitLabel = 'Save') {
  closeModal();
  const wrap = document.createElement('div');
  wrap.className = 'sh-modal';
  wrap.id = 'shModal';
  wrap.innerHTML = `<div class="sh-modal-card" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><form>${bodyHtml}<div class="sh-modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button>${onSubmit ? `<button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>` : ''}</div></form></div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) closeModal(); });
  wrap.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
  const form = wrap.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!onSubmit) return;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const r = await onSubmit(new FormData(form), form);
      if (r !== false) closeModal();
      else btn.disabled = false;
    } catch (err) {
      console.error(err);
      toast('Something went wrong. Check Firestore rules and try again.');
      btn.disabled = false;
    }
  });
  form.querySelector('input:not([type=checkbox]),select,textarea')?.focus();
}

// "Are you sure?" dialog. Resolves true (confirmed) or false (cancelled).
function confirmBox(title, message, okLabel = 'Yes, continue', danger = false) {
  return new Promise(resolve => {
    $('#confirmBox')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'sh-modal';
    wrap.id = 'confirmBox';
    wrap.innerHTML = `<div class="sh-modal-card sh-confirm" role="alertdialog" aria-modal="true"><div class="sh-confirm-ico ${danger ? 'danger' : ''}">${danger ? '🗑️' : '❓'}</div><h3>${esc(title)}</h3><p class="muted">${esc(message)}</p><div class="sh-modal-actions"><button type="button" class="btn btn-ghost" data-no>Cancel</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(wrap);
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    const done = v => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) done(false); });
    wrap.querySelector('[data-no]').addEventListener('click', () => done(false));
    wrap.querySelector('[data-yes]').addEventListener('click', () => done(true));
    wrap.querySelector('[data-yes]').focus();
  });
}

/* ───────────────────────── Firebase ───────────────────────── */
async function initFirebase() {
  if (!configured) return false;
  try {
    const base = 'https://www.gstatic.com/firebasejs/10.12.5/';
    // App Check is optional: it turns on only when firebase-config.js has  appCheckSiteKey: '<reCAPTCHA v3 site key>'.
    const useAppCheck = isSet(firebaseConfig.appCheckSiteKey);
    const [appmod, authmod, fsmod, acmod] = await Promise.all([
      import(base + 'firebase-app.js'),
      import(base + 'firebase-auth.js'),
      import(base + 'firebase-firestore.js'),
      useAppCheck ? import(base + 'firebase-app-check.js').catch(e => { console.warn('App Check could not load', e); return null; }) : null
    ]);
    // initializeApp/deleteApp are kept so we can create (and clean up) a secondary app when an admin creates a worker.
    fb = { ...authmod, ...fsmod, initializeApp: appmod.initializeApp, deleteApp: appmod.deleteApp };
    const app = appmod.initializeApp(firebaseConfig);
    // App Check must start before the first Firestore request: it proves the request comes from this website, not from a script using the public API key.
    if (acmod) {
      try {
        if (['localhost', '127.0.0.1'].includes(location.hostname)) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true; // local testing only: register the debug token printed in the console
        acmod.initializeAppCheck(app, { provider: new acmod.ReCaptchaEnterpriseProvider(firebaseConfig.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
      } catch (e) { console.warn('App Check could not start', e); }
    }
    auth = authmod.getAuth(app);
    // Local cache (IndexedDB, works across tabs): a page reload or a re-opened tab only pays for documents that changed.
    try {
      db = fsmod.initializeFirestore(app, { localCache: fsmod.persistentLocalCache({ tabManager: fsmod.persistentMultipleTabManager() }) });
    } catch (e) {
      console.warn('Local cache unavailable, using the default (memory) cache.', e);
      db = fsmod.getFirestore(app);
    }
    return true;
  } catch (e) {
    console.error(e);
    toast('Firebase could not initialize. Check your web config and internet connection.');
    return false;
  }
}

/* ───────────────────────── Rendering control ───────────────────────── */
function isEditing() {
  const el = document.activeElement;
  return !!el && !!el.closest?.('#pageContent') && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'checkbox';
}
// Snapshot-driven refresh: never wipe what the user is typing.
function requestRender(kind) {
  if (!currentUser || !profile) return;
  if (kind === 'chat') {
    if (page === 'chat') updateChat();
    if (page === 'dashboard') { updateLiveFeed(); updateTicker(); }
    return;
  }
  if (isEditing()) { pendingRender = true; return; }
  renderPage();
}
document.addEventListener('focusout', () => {
  if (!pendingRender) return;
  setTimeout(() => {
    if (pendingRender && !isEditing()) { pendingRender = false; renderPage(); }
  }, 150);
});

function listen(path, key, queryFn, fallbackFn) {
  const { collection, onSnapshot, query, where, orderBy, limit } = fb;
  let ref = collection(db, path);
  if (queryFn) ref = queryFn(ref, { query, where, orderBy, limit });
  const stop = onSnapshot(ref, s => {
    data[key] = s.docs.map(d => ({ id: d.id, ...d.data() }));
    loaded[key] = true;
    if (accessErr[key]) delete accessErr[key];
    if (key === 'submissions' || key === 'users') { scheduleLbSync(); scheduleStatsSync(); }
    if (key === 'accounts') { syncPeerListeners(); syncShiftListeners(); }
    requestRender();
  }, err => {
    if (fallbackFn && err?.code === 'failed-precondition') {
      // The composite index is not created yet: keep working with the broader query (more reads) until it exists.
      console.warn('Create this Firestore index to cut reads:', err.message);
      try { stop(); } catch {}
      listen(path, key, fallbackFn);
      return;
    }
    console.error(path, err);
    if (err?.code === 'permission-denied' && key !== 'audit') accessErr[key] = true;
    toast('Could not load ' + path + '. Check Firestore rules.');
    requestRender();
  });
  unsubs.push(stop);
}

async function loadData() {
  unlisten();
  if (!db || !profile) return;
  const { collection, doc, onSnapshot, query, where, orderBy, limit } = fb;
  const uid = currentUser.uid;

  // Reset so nothing from a previous login can leak into this session.
  data.announcements = []; data.annRead = [];
  data.submissions = []; data.accounts = []; data.users = [];
  data.messages = []; data.presence = []; data.leaderboard = []; data.accountStats = []; data.audit = [];
  data.threads = []; data.dmMessages = []; data.activeShifts = []; chatConv = 'group'; dmWith = ''; auditLimit = 50; subLimit = 50;
  data.settings = { ...DEFAULT_SETTINGS };
  loaded = {}; chatReady = false; unreadChat = 0; lbError = false; accessErr = {}; trackerErr = false;

  if (isAdmin()) {
    listen('accounts', 'accounts');
    // Only recent months (single-field range on shiftDate, no composite index needed). Older months come from /leaderboard totals.
    listen('submissions', 'submissions', (ref, q) => q.query(ref, q.where('shiftDate', '>=', subWindowMonth() + '-01')));
    listen('users', 'users');
    // audit log listener starts only when the Audit log page is opened (see go())
  } else {
    // Workers only query what they are allowed to read.
    listen('accounts', 'accounts', (ref, q) => q.query(ref, q.where('assignedWorkerIds', 'array-contains', uid)));
    // Only my recent months (needs the composite index workerId + shiftDate). Without it the full query below is used automatically.
    workerSubsWindowed = true;
    listen('submissions', 'submissions',
      (ref, q) => q.query(ref, q.where('workerId', '==', uid), q.where('shiftDate', '>=', workerWinMonth() + '-01')),
      (ref, q) => { workerSubsWindowed = false; return q.query(ref, q.where('workerId', '==', uid)); });
    data.users = [];
  }
  setupPrivateChat(uid);

  unsubs.push(onSnapshot(doc(db, 'users', uid), s => {
    if (!profile) return;
    if (!s.exists()) { if (!s.metadata.fromCache) forceLogout('Your account was removed by the administrator.'); return; }
    const live = s.data();
    if (live.status === 'deleted') { forceLogout('Your account was deleted by the administrator.', true); return; }
    if (live.isActive === false || live.status === 'rejected' || live.status === 'pending') { forceLogout('Your account is no longer active.'); return; }
    if (!['admin', 'worker'].includes(live.role) || live.role !== profile.role) { forceLogout('Your access changed. Please sign in again.'); return; }
    const next = s.data().shiftSchedule || null;
    if (JSON.stringify(next) !== JSON.stringify(profile.shiftSchedule || null)) {
      profile.shiftSchedule = next;
      requestRender();
    }
  }, () => {}));

  unsubs.push(onSnapshot(doc(db, 'settings', 'paySettings'), s => {
    data.settings = { ...DEFAULT_SETTINGS, ...(s.exists() ? s.data() : {}) };
    requestRender();
  }, () => {}));

  unsubs.push(onSnapshot(query(collection(db, 'announcements'), orderBy('createdAt', 'desc'), limit(isAdmin() ? 30 : 10)), s => {
    data.announcements = s.docs.map(d => ({ id: d.id, ...d.data() }));
    requestRender();
  }, err => console.warn('announcements listener (check Firestore rules)', err)));
  unsubs.push(onSnapshot(doc(db, 'announcementReads', uid), s => {
    data.annRead = s.exists() ? (s.data().dismissedIds || []) : [];
    syncAnnouncementPopup();
  }, err => console.warn('announcementReads listener (check Firestore rules)', err)));

  // /presence is no longer listened to here: it starts only on the Co-workers page (startPresenceListen), because every heartbeat is billed as a read for each listener.

  // Running shifts: one document per account while somebody is working on it.
  // Admin: the whole collection (one doc per running shift). Workers: per-account docs, started from the accounts listener (syncShiftListeners).
  if (isAdmin()) unsubs.push(onSnapshot(collection(db, 'activeShifts'), s => {
    trackerErr = false;
    data.activeShifts = s.docs.map(d => ({ id: d.id, ...d.data() }));
    loaded.activeShifts = true;
    requestRender();
  }, err => {
    console.warn('activeShifts listener (check Firestore rules for /activeShifts)', err);
    trackerErr = true;
    requestRender();
  }));

  // Leaderboard totals (one small doc per worker per month) so workers can see their rank without reading other workers' submissions.
  unsubs.push(onSnapshot(collection(db, 'leaderboard'), s => {
    lbError = false;
    data.leaderboard = s.docs.map(d => ({ id: d.id, ...d.data() }));
    loaded.leaderboard = true;
    scheduleLbSync();
    requestRender();
  }, err => {
    console.warn('leaderboard listener (check Firestore rules for /leaderboard)', err);
    lbError = true;
    requestRender();
  }));

  // Per-account, per-worker monthly totals (for the Co-worker page). Admin keeps them in sync; workers read only their own accounts, only on that page.
  if (isAdmin()) unsubs.push(onSnapshot(query(collection(db, 'accountStats'), where('month', '>=', subWindowMonth())), s => {
    data.accountStats = s.docs.map(d => ({ id: d.id, ...d.data() }));
    loaded.accountStats = true;
    scheduleStatsSync();
  }, err => console.warn('accountStats listener (publish the latest firestore.rules)', err)));
  if (isAdmin()) startWatch(); // one small listener (60 newest chats) so the admin is notified of new co-worker messages

  const msgQuery = query(collection(db, 'conversations', 'company_group', 'messages'), orderBy('createdAt', 'desc'), limit(CHAT_LIMIT));
  unsubs.push(onSnapshot(msgQuery, s => {
    // Popup for brand-new messages from other people (skip the very first load)
    if (chatReady) {
      s.docChanges().forEach(ch => {
        if (ch.type !== 'added' || ch.doc.metadata.hasPendingWrites) return;
        const m = { id: ch.doc.id, ...ch.doc.data() };
        if (m.senderId !== currentUser?.uid) onIncomingMessage(m);
      });
    }
    chatReady = true;
    data.messages = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => timeVal(a.createdAt) - timeVal(b.createdAt));
    requestRender('chat');
  }, err => { console.error('messages', err); toast('Could not load chat.'); }));
}

/* ───────────────────────── Leaderboard (top performers / top errors) ───────────────────────── */
const inPeriod = (m, p) => p === 'all' ? /^\d{4}-\d{2}$/.test(m) : p === 'prev' ? m === monthKeyOf(-1) : m === monthKeyOf(0);
const periodLabel = p => p === 'all' ? 'All time' : monthLabel(monthKeyOf(p === 'prev' ? -1 : 0));

function boardRows(period) {
  const map = new Map();
  const add = (id, name, r, e, sh) => {
    const g = map.get(id) || { id, name: name || 'Worker', receipts: 0, errors: 0, shifts: 0 };
    g.receipts += r; g.errors += e; g.shifts += sh;
    if (name) g.name = name;
    map.set(id, g);
  };
  const fromSubs = list => list.forEach(s => {
    if (s.status !== 'approved' || !s.workerId) return;
    if (!inPeriod(monthOf(s), period)) return;
    add(s.workerId, s.workerName, num(s.receiptCount), num(s.errorCount), 1);
  });
  if (isAdmin() || !configured) {
    fromSubs(data.submissions);
    if (isAdmin() && period === 'all') {
      // months older than the loaded submissions window exist only as leaderboard totals
      const ws = subWindowMonth();
      data.leaderboard.forEach(d => {
        if (!/^\d{4}-\d{2}$/.test(String(d.month || '')) || d.month >= ws) return;
        add(d.workerId, d.workerName, num(d.receipts), num(d.errors), num(d.shifts));
      });
    }
    const valid = new Set(liveUsers().filter(u => u.role !== 'admin').map(u => u.id)); // deleted workers are not ranked
    return [...map.values()].filter(r => valid.has(r.id));
  }
  const mineFrom = workerWinMonth();
  data.leaderboard.forEach(d => {
    if (!inPeriod(d.month, period)) return;
    // my recent months come live from my own submissions below; months older than my loaded window come from /leaderboard
    if (d.workerId === currentUser.uid && (!workerSubsWindowed || String(d.month || '') >= mineFrom)) return;
    add(d.workerId, d.workerName, num(d.receipts), num(d.errors), num(d.shifts));
  });
  fromSubs(data.submissions.filter(s => s.workerId === currentUser.uid)); // my own numbers always come from live data
  return [...map.values()];
}

function rankings(period) {
  const all = boardRows(period);
  const rows = all.filter(r => r.receipts > 0 || r.errors > 0);
  const byOut = [...rows].sort((a, b) => b.receipts - a.receipts || a.errors - b.errors || a.name.localeCompare(b.name));
  const byErr = rows.filter(r => r.errors > 0).sort((a, b) => b.errors - a.errors || b.receipts - a.receipts || a.name.localeCompare(b.name));
  return { rows, byOut, byErr, all };
}

// Keeps /leaderboard in sync. Admin only: Firestore rules intentionally deny worker writes.
function scheduleLbSync() { clearTimeout(lbTimer); lbTimer = setTimeout(syncLeaderboard, 1500); }
async function syncLeaderboard() {
  if (!configured || !db || !currentUser || !isAdmin() || !loaded.leaderboard || !loaded.submissions || !loaded.users) return;
  const validIds = new Set(liveUsers().filter(u => u.role !== 'admin').map(u => u.id));
  const mine = data.submissions.filter(s => s.workerId && validIds.has(s.workerId));
  const want = new Map();
  mine.forEach(s => {
    if (s.status !== 'approved') return;
    const m = monthOf(s);
    if (!/^\d{4}-\d{2}$/.test(m)) return;
    const id = `${s.workerId}_${m}`;
    const g = want.get(id) || { workerId: s.workerId, workerName: s.workerName || 'Worker', month: m, receipts: 0, errors: 0, shifts: 0 };
    g.receipts += num(s.receiptCount); g.errors += num(s.errorCount); g.shifts += 1;
    want.set(id, g);
  });
  // Anything stored before that no longer has submissions (edited, rejected, deleted) is reset to zero.
  const winStart = subWindowMonth();
  data.leaderboard.forEach(d => {
    if (!validIds.has(d.workerId) || want.has(d.id)) return;
    if (String(d.month || '') < winStart) return; // older than the loaded submissions: keep as is, never reset to zero
    if (num(d.receipts) || num(d.errors) || num(d.shifts)) want.set(d.id, { workerId: d.workerId, workerName: d.workerName || 'Worker', month: d.month, receipts: 0, errors: 0, shifts: 0 });
  });
  const old = new Map(data.leaderboard.map(d => [d.id, d]));
  const writes = [...want].filter(([id, g]) => {
    const o = old.get(id);
    return !o || num(o.receipts) !== g.receipts || num(o.errors) !== g.errors || num(o.shifts) !== g.shifts || (o.workerName || '') !== g.workerName;
  });
  if (!writes.length) return;
  try {
    await commitInChunks(writes.map(([id, g]) => b => b.set(fb.doc(db, 'leaderboard', id), { ...g, updatedAt: fb.serverTimestamp() }, { merge: true })));
  } catch (e) { console.warn('leaderboard write failed (check Firestore rules for /leaderboard)', e); }
}

const medal = i => ['🥇', '🥈', '🥉'][i] || `#${i + 1}`;
const errMedal = i => ['😡', '😭', '😢', '😟', '😕'][i] || `#${i + 1}`; // emojis for the error ranking

function top5Panel(title, sub, list, kind) {
  const val = r => kind === 'out' ? r.receipts : r.errors;
  const max = Math.max(1, ...list.slice(0, 5).map(val));
  const rows = list.slice(0, 5).map((r, i) => `<div class="lb-row"><span class="lb-rank">${kind === 'err' ? errMedal(i) : medal(i)}</span><div class="avatar">${esc(initials(r.name))}</div><div class="lb-main"><div class="lb-top"><b>${esc(r.name)}</b><span class="lb-val ${kind === 'err' ? 'err' : ''}">${val(r).toLocaleString()} ${kind === 'out' ? 'receipts' : 'error(s)'}</span></div><div class="lb-bar"><div class="lb-fill ${kind === 'err' ? 'err' : ''}" style="width:${(val(r) / max * 100).toFixed(1)}%"></div></div><small class="muted">${kind === 'out' ? num(r.errors).toLocaleString() + ' error(s) · ' : num(r.receipts).toLocaleString() + ' processed · '}${r.shifts} shift(s)</small></div></div>`).join('');
  return `<div class="panel"><div class="panel-head"><div><h3>${title}</h3><p>${sub}</p></div></div>${rows || `<div class="empty">${kind === 'out' ? '🏆' : '✓'}<b>${kind === 'out' ? 'No output recorded yet' : 'No errors recorded'}</b>${kind === 'out' ? 'Rankings appear after shifts are submitted.' : 'Great — nobody has errors in this period.'}</div>`}</div>`;
}

function workerStandings(rk, period) {
  const label = periodLabel(period);
  const uid = currentUser.uid;
  const me = rk.rows.find(r => r.id === uid);
  if (!me) return [{ cls: 'info', icon: '📝', title: 'No submissions yet', text: `Submit a shift for ${label} to see your ranking.` }];
  const n = rk.byOut.length;
  const rank = rk.byOut.findIndex(r => r.id === uid) + 1;
  const top = rk.byOut[0];
  const gap = top.receipts - me.receipts;
  let out;
  if (rank === 1) out = { cls: 'gold', icon: '🏆', title: 'Congratulations! You are the TOP PERFORMER', text: `You processed the most receipts (${me.receipts.toLocaleString()}) in ${label}. Outstanding work — keep it up!` };
  else if (rank === 2) out = { cls: 'silver', icon: '🥈', title: 'You are 2nd place in output', text: `${me.receipts.toLocaleString()} receipts processed — only ${gap.toLocaleString()} behind the top performer. You are almost there!` };
  else if (rank === 3) out = { cls: 'bronze', icon: '🥉', title: 'You are 3rd place in output', text: `${me.receipts.toLocaleString()} receipts processed — ${gap.toLocaleString()} behind the top performer. Great effort, keep pushing!` };
  else if (rank === n && n > 1) out = { cls: 'warn', icon: '📉', title: 'You have the lowest output', text: `${me.receipts.toLocaleString()} receipts processed in ${label}. Let's aim higher on your next shift — you can do it!` };
  else out = { cls: 'info', icon: '📊', title: `You are ${ordinal(rank)} of ${n} in output`, text: `${me.receipts.toLocaleString()} receipts processed — ${gap.toLocaleString()} behind the top performer.` };

  const er = rk.byErr.findIndex(r => r.id === uid) + 1;
  let err;
  if (me.errors === 0) err = { cls: 'good', icon: '✅', title: 'Zero errors — excellent accuracy!', text: `No error receipts recorded in ${label}. Keep up the clean work!` };
  else if (er === 1) err = { cls: 'danger', icon: '😡', title: 'You have the MOST errors', text: `${me.errors.toLocaleString()} error(s) in ${label}, the highest in the team. Please double-check each receipt before submitting.` };
  else if (er === 2) err = { cls: 'danger', icon: '😭', title: 'You have the 2nd highest errors', text: `${me.errors.toLocaleString()} error(s) in ${label}. Slow down a little and review your work to bring this down.` };
  else if (er === 3) err = { cls: 'warn', icon: '😢', title: 'You have the 3rd highest errors', text: `${me.errors.toLocaleString()} error(s) in ${label}. A little more checking will bring this down.` };
  else err = { cls: 'info', icon: '😕', title: `${me.errors.toLocaleString()} error(s) recorded`, text: `You are outside the top 3 for errors in ${label}. Keep your accuracy improving!` };
  return [out, err];
}

// Admin: total output / errors of EVERY worker for the selected period, approved + pending shifts (rejected are left out).
// Built from data the admin already has loaded, so it costs no extra reads or listeners.
function workerTotalsPanel(rk, label, period) {
  const byId = new Map(rk.all.map(r => [r.id, { ...r, pending: 0 }])); // rk.all = approved shifts (older months of "All time" come from /leaderboard)
  const valid = new Set(liveUsers().filter(u => u.role !== 'admin').map(u => u.id));
  data.submissions.forEach(s => {
    if (s.status !== 'pending' || !s.workerId || !valid.has(s.workerId) || !inPeriod(monthOf(s), period)) return;
    const g = byId.get(s.workerId) || { id: s.workerId, name: s.workerName || 'Worker', receipts: 0, errors: 0, shifts: 0, pending: 0 };
    g.receipts += num(s.receiptCount); g.errors += num(s.errorCount); g.shifts += 1; g.pending += 1;
    byId.set(s.workerId, g);
  });
  liveUsers().filter(u => u.role !== 'admin' && (u.status || 'approved') === 'approved' && u.isActive !== false).forEach(u => {
    if (!byId.has(u.id)) byId.set(u.id, { id: u.id, name: u.displayName || u.email || 'Worker', receipts: 0, errors: 0, shifts: 0, pending: 0 });
  });
  const list = [...byId.values()].sort((a, b) => b.receipts - a.receipts || a.errors - b.errors || a.name.localeCompare(b.name));
  const tot = list.reduce((t, r) => ({ receipts: t.receipts + r.receipts, errors: t.errors + r.errors, shifts: t.shifts + r.shifts, pending: t.pending + r.pending }), { receipts: 0, errors: 0, shifts: 0, pending: 0 });
  const pct = r => errRatePct(r.receipts, r.errors).toFixed(1) + '%';
  const body = list.map(r => `<tr><td><strong>${esc(r.name)}</strong></td><td>${r.shifts}</td><td>${r.receipts.toLocaleString()}</td><td>${r.errors.toLocaleString()}</td><td>${pct(r)}</td><td>${r.pending || '–'}</td></tr>`).join('');
  const foot = `<tr><td><strong>Total</strong></td><td><strong>${tot.shifts}</strong></td><td><strong>${tot.receipts.toLocaleString()}</strong></td><td><strong>${tot.errors.toLocaleString()}</strong></td><td><strong>${pct(tot)}</strong></td><td><strong>${tot.pending || '–'}</strong></td></tr>`;
  return `<div class="panel"><div class="panel-head"><div><h3>Worker totals</h3><p>${esc(label)} · approved + pending shifts · "Pending" = shifts still awaiting review (already included)</p></div></div><div class="table-wrap wt-wrap"><table><thead><tr><th>Worker</th><th>Shifts</th><th>Output</th><th>Errors</th><th>Error rate</th><th>Pending</th></tr></thead><tbody>${body ? body + foot : '<tr><td colspan="6"><div class="empty">No workers yet.</div></td></tr>'}</tbody></table></div></div>`;
}

function performanceSection() {
  const rk = rankings(lbPeriod);
  const label = periodLabel(lbPeriod);
  const tabs = `<div class="lb-tabs">${[['month', 'This month'], ['prev', 'Last month'], ['all', 'All time']].map(([k, l]) => `<button type="button" class="lb-tab ${lbPeriod === k ? 'active' : ''}" data-lb-period="${k}">${l}</button>`).join('')}</div>`;
  const head = `<div class="panel-head" style="margin:0 0 12px"><div><h3>🏆 ${isAdmin() ? 'Team performance' : 'My standing'}</h3><p>${esc(label)} · only approved shifts are counted</p></div>${tabs}</div>`;
  if (isAdmin()) {
    const views = `<div class="lb-tabs" style="margin:0 0 12px">${[['top', '🏆 Top performers'], ['totals', '👥 Worker totals']].map(([k, l]) => `<button type="button" class="lb-tab ${perfView === k ? 'active' : ''}" data-perf-view="${k}">${l}</button>`).join('')}</div>`;
    const view = perfView === 'totals'
      ? workerTotalsPanel(rk, label, lbPeriod) // computed only when this tab is open
      : `<div class="grid-2">${top5Panel('Top 5 performers', 'Most receipts processed · ' + esc(label), rk.byOut, 'out')}${top5Panel('Top 5 most errors', 'Highest error count · ' + esc(label), rk.byErr, 'err')}</div>`;
    return `<div class="perf">${head}${views}${view}</div>`;
  }
  const cards = workerStandings(rk, lbPeriod).map(c => `<div class="standing ${c.cls}"><div class="standing-ico">${c.icon}</div><div><b>${esc(c.title)}</b><p>${esc(c.text)}</p></div></div>`).join('');
  const warn = lbError ? `<div class="notice warn" style="margin-bottom:10px">Team ranking could not be loaded. Update your Firestore rules for the "leaderboard" collection.</div>` : '';
  const uid = currentUser.uid;
  const top3 = lbError ? '' : `<div style="margin-top:12px">${top5Panel('Top 3 performers', 'Most receipts processed · ' + esc(label), rk.byOut.slice(0, 3).map(r => r.id === uid ? { ...r, name: r.name + ' (you)' } : r), 'out')}</div>`;
  return `<div class="perf">${head}${warn}<div class="standing-grid">${cards}</div>${top3}</div>`;
}

/* ───────────────────────── Team chat: popups, badge, live feed ───────────────────────── */
function updateChatBadge() {
  $$('[data-nav="chat"]').forEach(b => {
    b.querySelector('.nav-badge')?.remove();
    if (unreadChat > 0) b.insertAdjacentHTML('beforeend', `<span class="nav-badge">${unreadChat > 9 ? '9+' : unreadChat}</span>`);
  });
}

function showChatPopup(m) {
  let box = $('#chatPopups');
  if (!box) { box = document.createElement('div'); box.id = 'chatPopups'; document.body.appendChild(box); }
  while (box.children.length >= 3) box.firstChild.remove();
  const t = String(m.text || m.message || '');
  const el = document.createElement('div');
  el.className = 'chat-pop';
  el.innerHTML = `<div class="avatar">${esc(initials(m.senderName))}</div><div class="chat-pop-body"><b>${m.peer ? '👥 ' : m.dm ? '🔒 Private · ' : '💬 '}${esc(m.senderName || 'Team member')}</b><span>${esc(t.length > 160 ? t.slice(0, 160) + '…' : t)}</span><small>${m.peer ? 'Co-worker message' : m.dm ? 'Private message' : 'New team message'} · click to open chat</small></div><button type="button" class="chat-pop-x" aria-label="Dismiss">×</button>`;
  el.addEventListener('click', e => {
    if (e.target.closest('.chat-pop-x')) { el.remove(); return; }
    el.remove();
    if (m.watch) { go('peerwatch'); openWatch(m.convId); return; }
    if (m.peer) { peerSel = peerContacts().find(c => c.convId === m.convId) || peerSel; stopPeerMsgs(); peerMsgs = []; go('coworkers'); return; }
    if (m.dm) { chatConv = 'dm'; if (isAdmin()) { dmWith = m.dmId; startDm(); } } else { chatConv = 'group'; }
    go('chat');
  });
  box.appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

function onIncomingMessage(m) {
  if (!currentUser || !profile) return;
  if (page === 'chat' && chatConv === 'group' && !document.hidden) return; // already reading the public chat
  unreadChat++;
  updateChatBadge();
  showChatPopup(m);
}

function liveFeedHtml() {
  const msgs = (data.messages || []).slice(-6);
  if (!msgs.length) return '<div class="empty"><span class="empty-ico">${EMPTY_ICONS.chat}</span><b>No messages yet</b>Start the conversation in Team chat.</div>';
  return msgs.map((m, i) => {
    const mine = m.senderId === currentUser?.uid;
    return `<div class="live-msg ${mine ? 'mine' : ''} ${i === msgs.length - 1 ? 'fresh' : ''}"><div class="avatar">${esc(initials(m.senderName))}</div><div class="live-body"><b>${esc(mine ? 'You' : (m.senderName || 'Team member'))}</b><span>${esc(m.text || m.message || '')}</span><small>${esc(fmtTime(m.createdAt))}</small></div></div>`;
  }).join('');
}
function liveChatPanel() {
  const last = (data.messages || []).slice(-1)[0]?.id || '';
  return `<div class="panel" style="margin-bottom:16px"><div class="panel-head"><div><h3>💬 Live team chat</h3><p>Latest messages, updated in real time</p></div><button class="small-btn" data-page="chat">Open chat →</button></div><div class="live-chat" id="liveChat" data-last="${esc(last)}">${liveFeedHtml()}</div></div>`;
}
function updateLiveFeed() {
  const el = $('#liveChat');
  if (!el) return;
  const last = (data.messages || []).slice(-1)[0]?.id || '';
  if (el.dataset.last === last) return;
  el.dataset.last = last;
  el.innerHTML = liveFeedHtml();
  el.scrollTop = el.scrollHeight;
}
function tickerInner() {
  const msgs = (data.messages || []).slice(-5);
  if (!msgs.length) return '<span class="muted" style="font-size:13px">No team messages yet</span>';
  const set = msgs.map(m => {
    const who = m.senderId === currentUser?.uid ? 'You' : (m.senderName || 'Team member');
    const txt = String(m.text || m.message || '').replace(/\s+/g, ' ').slice(0, 120);
    return `<span class="msg-item"><b>${esc(who)}:</b> ${esc(txt)}</span>`;
  }).join('');
  const dur = Math.max(15, msgs.length * 6);
  return `<div class="msg-ticker-track" style="animation-duration:${dur}s"><div class="msg-ticker-set">${set}</div><div class="msg-ticker-set" aria-hidden="true">${set}</div></div>`;
}
function messageTicker() {
  const last = (data.messages || []).slice(-1)[0]?.id || '';
  return `<div class="msg-ticker" id="msgTicker" data-page="chat" data-last="${esc(last)}" title="Open team chat"><span>💬</span><div class="msg-ticker-view">${tickerInner()}</div></div>`;
}
function updateTicker() {
  const el = $('#msgTicker');
  if (!el) return;
  const last = (data.messages || []).slice(-1)[0]?.id || '';
  if (el.dataset.last === last) return;
  el.dataset.last = last;
  el.querySelector('.msg-ticker-view').innerHTML = tickerInner();
}

/* ───────────────────────── Session check, audit listener, private chat ───────────────────────── */
// Signs the user out when their account is deactivated / deleted / changed while they are logged in.
async function forceLogout(msg, deleteLogin = false) {
  clearPresenceTimers();
  unlisten();
  if (configured && auth) {
    if (deleteLogin && auth.currentUser) { try { await fb.deleteUser(auth.currentUser); } catch (e) { console.warn('could not delete login', e); } }
    try { await fb.signOut(auth); } catch {}
  }
  currentUser = null; profile = null; page = 'dashboard'; detailId = null;
  renderLogin();
  if (msg) toast(msg);
}

function startAudit() {
  stopAudit();
  if (!configured || !db || !isAdmin()) return;
  const { collection, onSnapshot, query, orderBy, limit } = fb;
  auditUnsub = onSnapshot(query(collection(db, 'auditLogs'), orderBy('createdAt', 'desc'), limit(auditLimit)), s => {
    data.audit = s.docs.map(d => ({ id: d.id, ...d.data() }));
    auditMore = s.size >= auditLimit;
    if (page === 'audit') requestRender();
  }, err => { console.warn('audit listener (check Firestore rules for /auditLogs)', err); toast('Could not load audit log. Check Firestore rules.'); });
}
function stopAudit() { if (auditUnsub) { try { auditUnsub(); } catch {} auditUnsub = null; } }

// Private chat = one thread per worker (worker <-> admins). Workers can never read each other's threads.
const dmId = () => isAdmin() ? dmWith : currentUser?.uid;
const chatPeerName = () => { const u = data.users.find(x => x.id === dmWith); return u?.displayName || u?.email || 'Worker'; };
function stopDm() { if (dmUnsub) { try { dmUnsub(); } catch {} dmUnsub = null; } }
function startDm() {
  stopDm();
  data.dmMessages = [];
  dmReady = false;
  const id = dmId();
  if (!configured || !db || !id || !currentUser) return;
  const { collection, onSnapshot, query, orderBy, limit } = fb;
  dmUnsub = onSnapshot(query(collection(db, 'privateThreads', id, 'messages'), orderBy('createdAt', 'desc'), limit(CHAT_LIMIT)), s => {
    if (dmReady && !isAdmin()) { // workers get a popup for admin replies (admins are notified from the thread list)
      s.docChanges().forEach(ch => {
        if (ch.type !== 'added' || ch.doc.metadata.hasPendingWrites) return;
        const m = { id: ch.doc.id, ...ch.doc.data() };
        if (m.senderId === currentUser?.uid) return;
        if (page === 'chat' && chatConv === 'dm' && !document.hidden) return;
        unreadChat++;
        updateChatBadge();
        showChatPopup({ ...m, dm: true, dmId: id });
      });
    }
    dmReady = true;
    data.dmMessages = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => timeVal(a.createdAt) - timeVal(b.createdAt));
    requestRender('chat');
  }, err => { console.warn('private messages (check Firestore rules for /privateThreads)', err); toast('Could not load private messages. Check Firestore rules.'); });
}
function setupPrivateChat(uid) {
  const { collection, doc, onSnapshot } = fb;
  if (isAdmin()) {
    let ready = false;
    unsubs.push(onSnapshot(collection(db, 'privateThreads'), s => {
      if (ready) {
        s.docChanges().forEach(ch => {
          if (ch.type === 'removed' || ch.doc.metadata.hasPendingWrites) return;
          const t = ch.doc.data();
          if (!t.adminUnread || t.lastSenderId === uid) return;
          if (page === 'chat' && chatConv === 'dm' && dmWith === ch.doc.id && !document.hidden) return;
          unreadChat++;
          updateChatBadge();
          showChatPopup({ senderName: t.lastSenderName || t.workerName, text: t.lastText, dm: true, dmId: ch.doc.id });
        });
      }
      ready = true;
      data.threads = s.docs.map(d => ({ id: d.id, ...d.data() }));
      requestRender('chat');
    }, err => console.warn('privateThreads listener (check Firestore rules)', err)));
  } else {
    startDm();
    unsubs.push(onSnapshot(doc(db, 'privateThreads', uid), s => {
      data.threads = s.exists() ? [{ id: s.id, ...s.data() }] : [];
      requestRender('chat');
    }, err => console.warn('private thread listener (check Firestore rules)', err)));
  }
}
function markDmRead() {
  if (!configured || !db || page !== 'chat' || chatConv !== 'dm' || document.hidden) return;
  const id = dmId();
  const t = data.threads.find(x => x.id === id);
  const flag = isAdmin() ? 'adminUnread' : 'workerUnread';
  if (!t || !t[flag]) return;
  t[flag] = false; // avoid repeating while the write is in flight
  fb.updateDoc(fb.doc(db, 'privateThreads', id), { [flag]: false }).catch(() => {});
}
function chatListHtml() {
  const btn = (conv, id, ico, title, sub, active, unread) => `<button type="button" class="${active ? 'active' : ''}" data-chat-conv="${conv}" data-chat-id="${esc(id)}"><div class="avatar">${ico}</div><div><strong>${esc(title)}</strong><small>${esc(sub)}</small></div>${unread ? '<span class="nav-badge">●</span>' : ''}</button>`;
  let h = btn('group', '', '👥', 'Company group', 'Public · everyone can read', chatConv === 'group', false);
  if (isAdmin()) {
    const th = new Map(data.threads.map(t => [t.id, t]));
    const at = id => (th.get(id)?.lastAt ? timeVal(th.get(id).lastAt) : 0);
    const ws = liveUsers().filter(u => u.role === 'worker' && (u.status || 'approved') === 'approved')
      .sort((a, b) => at(b.id) - at(a.id) || (a.displayName || '').localeCompare(b.displayName || ''));
    h += ws.map(w => btn('dm', w.id, '🔒', w.displayName || w.email || 'Worker', th.get(w.id)?.lastText || 'Private message', chatConv === 'dm' && dmWith === w.id, !!th.get(w.id)?.adminUnread)).join('');
  } else {
    h += btn('dm', currentUser.uid, '🔒', 'Admin', 'Private · only you and admin', chatConv === 'dm', !!data.threads[0]?.workerUnread);
  }
  return h;
}
function openChat(conv, id) {
  if (conv === 'group') {
    chatConv = 'group';
    if (isAdmin()) stopDm();
  } else {
    chatConv = 'dm';
    if (isAdmin() && (dmWith !== id || !dmUnsub)) { dmWith = id; startDm(); }
  }
  renderPage();
}
async function sendDm(item, input) {
  const id = dmId();
  if (!id) { toast('Pick a worker first.'); return; }
  if (!configured) {
    data.dmMessages.push({ ...item, id: 'd' + Date.now(), createdAt: new Date() });
    input.value = '';
    updateChat();
    return;
  }
  input.value = '';
  try {
    const w = data.users.find(u => u.id === id);
    const b = fb.writeBatch(db);
    b.set(fb.doc(fb.collection(db, 'privateThreads', id, 'messages')), { ...item, createdAt: fb.serverTimestamp() });
    b.set(fb.doc(db, 'privateThreads', id), {
      workerId: id, workerName: isAdmin() ? (w?.displayName || w?.email || 'Worker') : profile.displayName,
      lastText: item.text.slice(0, 200), lastSenderId: currentUser.uid, lastSenderName: profile.displayName,
      lastAt: fb.serverTimestamp(), adminUnread: !isAdmin(), workerUnread: isAdmin()
    }, { merge: true });
    await b.commit();
  } catch (err) {
    console.error(err);
    input.value = item.text; // restore so nothing is lost
    toast('Could not send private message. Check Firestore rules.');
  }
}
// Table rows, 50 at a time
function submissionRowsPaged(rows) {
  const sorted = rows.slice().sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt));
  const more = sorted.length > subLimit ? `<tr><td colspan="8" style="text-align:center"><button type="button" class="small-btn" data-more-subs>Show 50 more (${sorted.length - subLimit} left)</button></td></tr>` : '';
  return submissionRows(sorted.slice(0, subLimit)) + more;
}

/* ───────────────────────── Demo mode ───────────────────────── */
function demoSignIn(role) {
  unlisten();
  const admin = role === 'admin';
  currentUser = { uid: admin ? 'demo-admin' : 'demo-worker', email: admin ? 'admin@demo.local' : 'worker@demo.local', displayName: admin ? 'Demo Administrator' : 'Demo Worker' };
  profile = { id: currentUser.uid, email: currentUser.email, displayName: currentUser.displayName, role, isActive: true, status: 'approved', assignedAccountIds: ['abk-01'] };
  data.accounts = [{ id: 'abk-01', name: 'Abukai Team Alpha', code: 'ABK-01', isActive: true, assignedWorkerIds: ['demo-worker', 'worker-2'], assignedWorkerNames: ['Demo Worker', 'Jamie Santos'] }];
  data.users = [profile,
    { id: 'demo-worker', displayName: 'Demo Worker', email: 'worker@demo.local', role: 'worker', isActive: true, status: 'approved', assignedAccountIds: ['abk-01'] },
    { id: 'worker-2', displayName: 'Jamie Santos', email: 'jamie@example.com', role: 'worker', isActive: true, status: 'approved', assignedAccountIds: [] },
    { id: 'worker-3', displayName: 'Pat Reyes', email: 'pat@example.com', role: 'worker', isActive: true, status: 'pending', assignedAccountIds: [] }];
  const t = todayStr();
  data.submissions = [
    { id: 'demo-1', workerId: 'demo-worker', workerName: 'Demo Worker', accountId: 'abk-01', accountName: 'Abukai Team Alpha', shiftDate: t, shiftType: 'Morning', startTime: '06:00', endTime: '14:00', receiptCount: 125, errorCount: 4, errorNote: 'Blurry images', status: 'approved', rateCents: 100, deductionPercent: 10, grossCents: 12500, deductionCents: 1250, netCents: 11250, createdAt: new Date() },
    { id: 'demo-2', workerId: 'worker-2', workerName: 'Jamie Santos', accountId: 'abk-01', accountName: 'Abukai Team Alpha', shiftDate: t, shiftType: 'Afternoon', startTime: '14:00', endTime: '22:00', receiptCount: 96, errorCount: 0, errorNote: '', status: 'pending', rateCents: 100, deductionPercent: 10, grossCents: 9600, deductionCents: 960, netCents: 8640, createdAt: new Date() }];
  data.messages = [{ id: 'm1', senderId: 'worker-2', senderName: 'Jamie Santos', text: 'Hi team, my shift submission is ready for review.', createdAt: new Date() }];
  data.presence = [{ id: 'demo-worker', displayName: 'Demo Worker', role: 'worker', demo: true }, { id: 'worker-2', displayName: 'Jamie Santos', role: 'worker', demo: true }];
  data.leaderboard = []; data.accountStats = [];
  data.audit = [];
  data.activeShifts = [];
  data.threads = []; data.dmMessages = []; chatConv = 'group'; dmWith = '';
  data.settings = { ...DEFAULT_SETTINGS };
  accessErr = {};
  trackerErr = false;
  page = 'dashboard';
  unreadChat = 0;
  renderPage();
  toast('Demo mode: changes are not saved online.');
  showShiftWarning();
}

/* ───────────────────────── Login ───────────────────────── */
function authError(code) {
  return ({
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/user-not-found': 'No account found for this email.',
    'auth/wrong-password': 'Email or password is incorrect.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/too-many-requests': 'Too many attempts. Try again later.',
    'auth/network-request-failed': 'Network error. Check your connection.'
  })[code] || 'Could not sign in: ' + (code || 'unknown error');
}

function renderLogin() {
  unlisten();
  closeModal();
  closeAnnPopup();
  $('#shiftWarn')?.remove();
  $('#shiftRemind')?.remove();
  $('#confirmBox')?.remove();
  $('#chatPopups')?.remove();
  unreadChat = 0;
  $('#app').innerHTML = `<main class="login-wrap"><section class="login-art"><div class="brand"><img src="assets/logo.jpg" alt=""><div><strong>STEIVY</strong><small>RECEIPT HUB</small></div></div><div><h1>Keep every shift<br>in good order.</h1><p>Manage receipt submissions, track shift totals, review reports, and stay connected with your team.</p></div><ul class="login-points"><li><span>${EMPTY_ICONS.receipts}</span>Log every shift and receipt in one place</li><li><span>${EMPTY_ICONS.reports}</span>Clear reports and earnings, always up to date</li><li><span>${EMPTY_ICONS.chat}</span>Stay connected with your team in real time</li></ul><div class="art-foot"><p>One hub for your team's daily operations.</p></div></section><section class="login-form-side"><form id="loginForm" class="login-form"><div class="brand-mark">S</div><h2>Welcome back</h2><p class="muted">Sign in to continue to your workspace.</p>${!configured ? `<div class="demo-note"><b>Firebase setup required</b><br>This copy has no Firebase web credentials yet. You can preview the interface with demo accounts below; demo changes are not saved online.</div>` : ''}<div class="field"><label for="email">EMAIL ADDRESS</label><input id="email" type="email" placeholder="you@company.com" autocomplete="username" required></div><div class="field"><label for="password">PASSWORD</label><div class="pw-wrap"><input id="password" type="password" placeholder="Enter your password" autocomplete="current-password" required><button type="button" class="pw-toggle" id="pwToggle" aria-label="Show password">Show</button></div></div><button class="btn btn-primary btn-block" type="submit">Sign in <span>→</span></button><p class="muted" style="font-size:12px;text-align:center;margin:18px 0">Need an account? Ask your administrator to create or approve it.</p><p class="login-foot">🔒 Secure sign-in · © ${new Date().getFullYear()} Steivy Receipt Hub</p>${!configured ? `<div class="field"><label>PREVIEW WITHOUT FIREBASE</label><button class="btn btn-light btn-block" type="button" id="demoWorker">Continue as demo worker</button><button class="btn btn-ghost btn-block" style="margin-top:8px" type="button" id="demoAdmin">Preview admin dashboard</button></div>` : ''}<div class="footer-note">Steivy Receipt Hub · Web edition</div></form></section></main>`;

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!configured) { toast('Add Firebase web configuration to enable sign-in.'); return; }
    const btn = e.currentTarget.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await fb.signInWithEmailAndPassword(auth, $('#email').value.trim(), $('#password').value);
    } catch (err) {
      toast(authError(err.code));
      btn.disabled = false;
    }
  });
  $('#pwToggle')?.addEventListener('click', e => { const i = $('#password'), show = i.type === 'password'; i.type = show ? 'text' : 'password'; e.currentTarget.textContent = show ? 'Hide' : 'Show'; e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); });
  $('#demoWorker')?.addEventListener('click', () => demoSignIn('worker'));
  $('#demoAdmin')?.addEventListener('click', () => demoSignIn('admin'));
}

/* ───────────────────────── Layout ───────────────────────── */
/* Inline SVG icons (Lucide-style, stroke = currentColor) */
const svgI = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
const NAV_ICONS = {
  dashboard: svgI('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  receipts: svgI('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
  errors: svgI('<path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>'),
  missed: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  workers: svgI('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>'),
  accounts: svgI('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>'),
  chat: svgI('<path d="M21 12a8.5 8.5 0 0 1-12.4 7.5L3 21l1.5-5.2A8.5 8.5 0 1 1 21 12z"/>'),
  coworkers: svgI('<path d="M17 18a5 5 0 0 0-10 0"/><circle cx="12" cy="9" r="3.2"/><path d="M21 17a4 4 0 0 0-3-3.8M3 17a4 4 0 0 1 3-3.8"/>'),
  peerwatch: svgI('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  reports: svgI('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  settings: svgI('<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  audit: svgI('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
  more: svgI('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>')
};
const EMPTY_ICONS = {
  ...NAV_ICONS,
  check: svgI('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>'),
  announce: svgI('<path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>')
};
const skelRows = (cols, n = 4) => Array.from({ length: n }, () => `<tr class="skel-row">${'<td><span class="skel"></span></td>'.repeat(cols)}</tr>`).join('');
const PAGE_TITLES = { dashboard: 'Dashboard', receipts: 'Receipt submissions', errors: 'Error processed', accounts: 'Account management', reports: 'Reports & earnings', chat: 'Team chat', coworkers: 'Co-worker chat', peerwatch: 'Co-worker chats', workers: 'Worker management', settings: 'Pay settings', missed: 'Missed shifts', audit: 'Audit log' };
const allowedPages = () => isAdmin() ? ['dashboard', 'receipts', 'errors', 'accounts', 'reports', 'chat', 'peerwatch', 'workers', 'settings', 'missed', 'audit'] : ['dashboard', 'receipts', 'errors', 'reports', 'chat', 'coworkers'];

function shell() {
  const groups = isAdmin() ? [
    ['OVERVIEW', [['dashboard', '⌂', 'Dashboard'], ['receipts', '▤', 'Submissions'], ['errors', '⚠', 'Error processed'], ['missed', '⏱', 'Missed shifts']]],
    ['PEOPLE', [['workers', '♙', 'Workers'], ['accounts', '▦', 'Accounts']]],
    ['COMMUNICATION', [['chat', '☏', 'Team chat'], ['peerwatch', '☺', 'Co-worker chats']]],
    ['ADMIN', [['reports', '▥', 'Reports'], ['settings', '⚙', 'Pay settings'], ['audit', '✎', 'Audit log']]]
  ] : [
    ['WORK', [['dashboard', '⌂', 'Dashboard'], ['receipts', '▤', 'Submissions'], ['errors', '⚠', 'Error processed']]],
    ['INSIGHTS', [['reports', '▥', 'Reports']]],
    ['COMMUNICATION', [['chat', '☏', 'Team chat'], ['coworkers', '☺', 'Co-worker chat']]]
  ];
  const groupLabel = (groups.find(g => g[1].some(n => n[0] === page)) || ['WORKSPACE'])[0];
  const title = PAGE_TITLES[page] || 'Dashboard';
  const badge = k => { const n = k === 'chat' ? unreadChat : k === 'coworkers' ? peerUnread() : k === 'peerwatch' ? watchUnread() : 0; return n > 0 ? `<span class="nav-badge">${n > 9 ? '9+' : n}</span>` : ''; };
  return `<div class="shell"><aside class="sidebar" id="sidebar"><div class="brand"><img src="assets/logo.jpg" alt=""><div><strong>STEIVY</strong><small>RECEIPT HUB</small></div></div><nav class="nav" aria-label="Main">${groups.map(g => `<div class="nav-label">${g[0]}</div>${g[1].map(n => `<button data-nav="${n[0]}" class="${page === n[0] ? 'active' : ''}"${page === n[0] ? ' aria-current="page"' : ''}><span class="ico">${NAV_ICONS[n[0]] || n[1]}</span>${n[2]}${badge(n[0])}</button>`).join('')}`).join('')}</nav>${!isAdmin() && workUrl() ? `<a class="btn btn-primary start-work" id="startWork" href="${esc(workUrl())}" target="_blank" rel="noopener noreferrer">▶ Start work</a>` : ''}<div class="sidebar-bottom"><button type="button" class="whats-new-link" id="whatsNewBtn">What’s new</button><div class="user-mini"><div class="avatar">${esc(initials(profile?.displayName))}</div><div><strong>${esc(profile?.displayName || 'User')}</strong><small>${isAdmin() ? 'Administrator' : 'Worker'}</small></div></div><button class="btn btn-ghost btn-block" id="logout">↪ Sign out</button></div></aside><main class="main"><header class="topbar"><div class="right"><button class="btn btn-ghost mobile-menu" id="menuBtn">☰</button><div><div class="crumb">${esc(groupLabel)} / ${esc(title.toUpperCase())}</div><h1>${esc(title)}</h1></div></div><div class="top-actions"><span class="mode-pill">${configured ? '● Connected app' : '◉ Demo preview'}</span><button type="button" class="btn btn-ghost" id="themeBtn" title="${theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}" aria-label="${theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}">${theme === 'dark' ? '☀' : '☾'}</button><button type="button" class="btn btn-ghost" id="logoutTop">↪ Sign out</button><div class="avatar">${esc(initials(profile?.displayName))}</div></div></header>${!configured ? '<div class="demo-banner">Demo preview — data is sample-only and will reset when you leave. Configure Firebase to use real accounts and save changes.</div>' : ''}<section class="content" id="pageContent"></section></main><nav class="bottom-nav" aria-label="Quick navigation">${[['dashboard', 'Home'], ['receipts', 'Shifts'], ['chat', 'Chat'], ['reports', 'Reports']].map(n => `<button type="button" data-nav="${n[0]}" class="${page === n[0] ? 'active' : ''}"${page === n[0] ? ' aria-current="page"' : ''}>${NAV_ICONS[n[0]]}<span>${n[1]}</span>${badge(n[0])}</button>`).join('')}<button type="button" id="moreBtn">${NAV_ICONS.more}<span>More</span></button></nav></div>`;
}

const stat = (label, value, sub, ico) => `<div class="stat"><div class="stat-head">${label}<span class="stat-icon">${ico}</span></div><strong>${value}</strong><small>${sub}</small></div>`;
const status = s => `<span class="status ${esc(String(s || 'pending').toLowerCase())}">${esc(s || 'pending')}</span>`;

// Shown to the admin when Firestore refuses to let them read the main collections.
function accessBanner() {
  if (!configured || !isAdmin()) return '';
  const keys = Object.keys(accessErr);
  if (!keys.length) return '';
  return `<div class="notice warn" style="margin-bottom:16px"><b>Admin access is blocked by Firestore rules</b> (${esc(keys.join(', '))}).<br>1) Open Firestore → <code>users/${esc(currentUser?.uid || '')}</code> and make sure it has <code>role: "admin"</code>, <code>status: "approved"</code> and <code>isActive: true</code>.<br>2) Publish the latest <code>firestore.rules</code>, then sign out and sign in again.</div>`;
}

/* ───────────────────────── Pages ───────────────────────── */
function submissionRows(rows) {
  if (configured && !loaded.submissions && !rows.length) return skelRows(8, 4);
  if (!rows.length) return `<tr><td colspan="8"><div class="empty"><span class="empty-ico">${EMPTY_ICONS.receipts}</span><b>No submissions yet</b>Shift submissions will appear here.</div></td></tr>`;
  return rows.slice().sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt)).map(s => {
    const err = num(s.errorCount);
    return `<tr><td><div class="person"><div class="avatar">${esc(initials(s.workerName))}</div><div><strong>${esc(s.workerName || 'Worker')}</strong><small>${esc(s.accountName || 'No account')}</small></div></div></td><td>${esc(date(s.shiftDate))}</td><td>${esc(s.shiftType || '—')}<small style="display:block;color:#8a958e;margin-top:4px">${esc(s.startTime || '')} – ${esc(s.endTime || '')}</small></td><td>${num(s.receiptCount).toLocaleString()}</td><td${err > 0 ? ' style="color:#c0392b;font-weight:600"' : ''}>${err.toLocaleString()}</td><td>${money(s.netCents)}</td><td>${status(s.status)}</td><td><div class="sh-row-actions"><button class="small-btn" data-view="${esc(s.id)}">View</button>${isAdmin() ? rowAdminBtns(s) : ''}</div></td></tr>`;
  }).join('');
}

// How long the oldest pending submission has been waiting (plain maths on data already loaded)
function pendingAge(pending) {
  if (!pending.length) return '';
  const ms = Date.now() - Math.min(...pending.map(s => timeVal(s.createdAt)));
  const h = Math.floor(ms / 3600000), d = Math.floor(h / 24);
  const t = d >= 1 ? `${d} day${d === 1 ? '' : 's'}` : h >= 1 ? `${h} hour${h === 1 ? '' : 's'}` : 'less than an hour';
  return ` Oldest has been waiting ${t}.`;
}
function dashboard() {
  const rows = visibleSubmissions();
  const approved = rows.filter(s => s.status === 'approved');
  const pending = rows.filter(s => s.status === 'pending');
  const total = approved.reduce((n, s) => n + num(s.receiptCount), 0);
  const errTotal = approved.reduce((n, s) => n + num(s.errorCount), 0);
  const earned = approved.reduce((n, s) => n + num(s.netCents), 0);
  const curMonth = monthKeyOf(0);
  const prevMonth = monthKeyOf(-1);
  const earnedMonth = approved.filter(s => monthOf(s) === curMonth).reduce((n, s) => n + num(s.netCents), 0);
  const earnedPrev = approved.filter(s => monthOf(s) === prevMonth).reduce((n, s) => n + num(s.netCents), 0);
  const monthPct = earnedPrev > 0 ? Math.round(earnedMonth / earnedPrev * 100) : null;
  const monthBar = monthPct === null ? '' : `<span class="mini-bar" role="img" aria-label="${monthPct}% of last month"><i style="width:${Math.min(100, monthPct)}%"></i></span><span class="mini-bar-txt">${monthPct >= 100 ? 'Above last month' : monthPct + '% of last month'}</span>`;
  const recent = rows.slice().sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt)).slice(0, 5);
  const first = esc((profile.displayName || 'there').split(' ')[0]);
  const noticeBar = `<div class="notice">${isAdmin() ? `You have <b>${pending.length}</b> submission(s) waiting for review.${pendingAge(pending)}${pending.length ? ' <button type="button" class="small-btn" data-review-pending>Review now →</button>' : ''}${missedNotice()}` : `Your approved submissions show in earnings. If a shift is rejected, check the reason and submit a correction.`}</div>`;
  const recentPanel = `<div class="panel"><div class="panel-head"><div><h3>Recent submissions</h3><p>Latest shift records and review status</p></div><button class="small-btn" data-page="receipts">View all →</button></div><div class="table-wrap"><table><thead><tr><th>Worker / account</th><th>Shift date</th><th>Shift</th><th>Processed</th><th>Errors</th><th>Net pay</th><th>Status</th><th></th></tr></thead><tbody>${submissionRows(recent)}</tbody></table></div></div>`;
  return `<div class="welcome"><div><h2>${isAdmin() ? 'Good day, Administrator' : 'Welcome back, ' + first + ' 👋'}</h2><p>Here’s what’s happening with ${isAdmin() ? 'your team' : 'your shifts'} today.</p></div>${messageTicker()}${!isAdmin() ? '<button class="btn btn-primary" data-page="receipts">▶ Start / end shift</button>' : '<button class="btn btn-primary" data-page="receipts">Review submissions →</button>'}</div>${errorWarningPanel()}${noticeBar}<div class="stats">${stat(isAdmin() ? 'Total submissions' : 'My submissions', rows.length, isAdmin() ? 'All recorded shifts' : 'Your recorded shifts', '▤')}${stat('Receipts processed', total.toLocaleString(), `${errTotal.toLocaleString()} with errors (included)`, '▧')}${stat('Pending review', pending.length, 'Awaiting a decision', '◷')}${stat(isAdmin() ? 'This month net pay so far' : 'This month earnings so far', money(earnedMonth), `${esc(monthLabel(curMonth))} · approved only · last month ${money(earnedPrev)}${monthBar}`, '₱')}</div>${monthStats(rows)}<div class="dash-grid"><div class="dash-main">${recentPanel}${performanceSection()}</div><div class="dash-side">${liveChatPanel()}${onlineStrip()}${isAdmin() ? announcementsPanel() : ''}</div></div>`;
}

function filteredSubmissions() {
  const q = filters.q.trim().toLowerCase();
  return visibleSubmissions().filter(x => (filters.status === 'all' || x.status === filters.status) &&
    (!q || `${x.workerName || ''} ${x.accountName || ''} ${x.shiftDate || ''}`.toLowerCase().includes(q)) &&
    (!filters.from || String(x.shiftDate || '') >= filters.from) && (!filters.to || (x.shiftDate && String(x.shiftDate) <= filters.to)));
}

// (Old manual form. Workers now use the shift tracker below, so this is no longer shown. Kept for reference.)
function submissionForm() {
  const uid = currentUser.uid;
  const accts = data.accounts.filter(a => a.isActive !== false && (!a.assignedWorkerIds || a.assignedWorkerIds.includes(uid)));
  const sc = scheduleOf(profile), inWin = inWindow(sc);
  const defFrom = sc && !sc.open ? sc.from : '06:00', defTo = sc && !sc.open ? sc.to : '14:00';
  return `<div class="panel" id="submissionFormPanel"><div class="panel-head"><div><h3>Submit completed shift</h3><p>Enter your shift details. Pay is calculated on processed receipts using current settings. You can submit only once per shift for each account.</p></div></div><div id="shiftGate" data-ok="${inWin}">${shiftNoticeHtml(sc, inWin)}</div><form id="submissionForm"><div class="form-grid"><div class="field"><label>ACCOUNT</label><select name="accountId" required>${accts.map(a => `<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.code || '')})</option>`).join('') || '<option value="">No active accounts assigned</option>'}</select></div><div class="field"><label>SHIFT DATE</label><input name="shiftDate" type="date" value="${defaultShiftDate(sc)}" max="${todayStr()}" ${sc && !sc.open ? 'readonly' : ''} required></div>${sc && !sc.open ? `<div class="field"><label>SHIFT</label><input value="${esc(sc.label)}" readonly></div>` : '<div class="field"><label>SHIFT</label><select name="shiftType"><option>Morning</option><option>Afternoon</option><option>Night</option><option>Custom</option></select></div>'}<div class="field"><label>PROCESSED RECEIPTS</label><input name="receiptCount" type="number" min="0" step="1" placeholder="e.g. 125" required></div><div class="field"><label>ERROR COUNT</label><input name="errorCount" type="number" min="1" step="1" placeholder="e.g. 3" required></div><div class="field"><label>START TIME</label><input name="startTime" type="time" value="${defFrom}" ${sc && !sc.open ? 'readonly' : ''} required></div><div class="field"><label>END TIME</label><input name="endTime" type="time" value="${defTo}" ${sc && !sc.open ? 'readonly' : ''} required></div><div class="full right" style="justify-content:flex-end;margin:0 0 8px"><button class="btn btn-primary" type="submit" data-noacct="${accts.length ? '0' : '1'}" ${accts.length && inWin ? '' : 'disabled'}>Submit for review →</button></div></div></form></div>`;
}

/* ───────────────────────── Shift tracker (Start shift / End shift with pasted Abukai stats) ───────────────────────── */
const STALE_MS = 18 * 3600 * 1000; // a running shift older than this is flagged "stale" so an admin can release it
const activeShiftOf = accountId => data.activeShifts.find(s => s.id === accountId);
const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// Reads the text copied from the Abukai "Processing Stats" page. Returns { submitted, errors } or null.
function parseAbukaiStats(text) {
  const t = String(text || '').replace(/\u00a0/g, ' ');
  const n = s => Number(String(s).replace(/,/g, ''));
  const a = t.match(/(\d[\d,]*)\s+submitted\s+receipt\(?s?\)?\s+this\s+month/i);
  const b = t.match(/(\d[\d,]*)\s+submitted\s+receipt\(?s?\)?\s+with\s+errors?\s+this\s+month/i);
  if (!a || !b) return null;
  const submitted = n(a[1]), errors = n(b[1]);
  if (!Number.isFinite(submitted) || !Number.isFinite(errors) || errors > submitted) return null;
  return { submitted, errors };
}

// Worker view: one row per assigned account with Start / End shift.
function trackerPanel() {
  const uid = currentUser.uid;
  const accts = data.accounts.filter(a => a.isActive !== false && (!a.assignedWorkerIds || a.assignedWorkerIds.includes(uid)));
  const sc = scheduleOf(profile), inWin = inWindow(sc);
  const warn = trackerErr ? `<div class="notice warn" style="margin-bottom:10px">The shift tracker could not be loaded. Publish the latest firestore.rules (collection "activeShifts").</div>` : '';
  const rows = accts.map(a => {
    const s = activeShiftOf(a.id);
    const title = `<strong>${esc(a.name)}</strong>${a.code ? ` <span class="muted">(${esc(a.code)})</span>` : ''}`;
    if (!s) {
      return `<div class="trk-row"><div class="trk-info">${title}<small><span class="trk-free">Available</span></small></div><div class="sh-row-actions"><button class="btn btn-primary" data-start-shift="${esc(a.id)}" ${inWin ? '' : 'disabled'}>▶ Start shift</button></div></div>`;
    }
    const stale = Date.now() - timeVal(s.startedAt) > STALE_MS;
    const since = `${esc(fmtTime(s.startedAt))}`;
    if (s.workerId === uid) {
      const b = s.startStats || {};
      return `<div class="trk-row"><div class="trk-info">${title}<small><span class="trk-live">● Working (you)</span> · since ${since}<br>Baseline: ${num(b.submitted).toLocaleString()} submitted · ${num(b.errors).toLocaleString()} with errors</small></div><div class="sh-row-actions"><button class="btn btn-primary" data-end-shift="${esc(a.id)}">■ End shift</button><button class="small-btn" data-cancel-shift="${esc(a.id)}">Cancel</button></div></div>`;
    }
    return `<div class="trk-row"><div class="trk-info">${title}<small><span class="trk-live">● Working</span> · ${esc(s.workerName || 'Another worker')} · since ${since}${stale ? '<br>⚠ Running for a very long time. Ask the admin to release it if it was forgotten.' : ''}</small></div><div class="sh-row-actions"><button class="btn btn-secondary" disabled data-start-shift="${esc(a.id)}" data-busy="1">▶ Start shift (working)</button></div></div>`;
  }).join('') || `<div class="empty"><span class="empty-ico">${EMPTY_ICONS.accounts}</span><b>No active accounts assigned</b>Ask your administrator to assign you to an account.</div>`;
  return `<div class="panel" id="submissionFormPanel"><div class="panel-head"><div><h3>Shift tracker</h3><p>1) Copy the Abukai <b>Processing Stats</b> page (Ctrl+A, Ctrl+C). 2) Press <b>Start shift</b> and paste it. 3) When you finish, copy the stats again, press <b>End shift</b> and paste. Your output and errors are computed from the difference. Only one shift can run on an account at a time. Errors that Abukai shows later are added automatically to the previous shift.</p></div></div><div id="shiftGate" data-ok="${inWin}">${shiftNoticeHtml(sc, inWin)}</div>${warn}${rows}</div>`;
}

// Admin view: who is working on which account right now (with a Release button for forgotten shifts).
function activeShiftsPanel() {
  const list = data.activeShifts.slice().sort((a, b) => timeVal(a.startedAt) - timeVal(b.startedAt));
  const warn = trackerErr ? `<div class="notice warn" style="margin-bottom:10px">The shift tracker could not be loaded. Publish the latest firestore.rules (collection "activeShifts").</div>` : '';
  const rows = list.map(s => {
    const stale = Date.now() - timeVal(s.startedAt) > STALE_MS;
    const b = s.startStats || {};
    return `<div class="trk-row"><div class="trk-info"><strong>${esc(s.accountName || s.id)}</strong><small><span class="trk-live">● Working</span> · ${esc(s.workerName || 'Worker')} · since ${esc(date(s.startedAt))} ${esc(fmtTime(s.startedAt))}${stale ? ' · ⚠ stale' : ''}<br>Baseline: ${num(b.submitted).toLocaleString()} submitted · ${num(b.errors).toLocaleString()} with errors</small></div><div class="sh-row-actions"><button class="small-btn" data-release-shift="${esc(s.id)}">Release</button></div></div>`;
  }).join('');
  return `<div class="panel"><div class="panel-head"><div><h3>Running shifts</h3><p>Accounts that currently have a worker on shift. Release a shift only if the worker forgot to end it (nothing is submitted).</p></div></div>${warn}${rows || '<div class="empty"><span class="empty-ico">${EMPTY_ICONS.check}</span><b>No running shifts</b>Accounts are free.</div>'}</div>`;
}

function liveStatsPreview(boxSel, base) {
  const ta = $('#trkPaste'), box = $(boxSel);
  if (!ta || !box) return;
  ta.addEventListener('input', () => {
    const p = parseAbukaiStats(ta.value);
    if (!p) { box.className = 'notice warn'; box.textContent = '⚠ Could not read the stats. Copy the whole Abukai Processing Stats page and paste it again.'; return; }
    if (!base) { box.className = 'notice'; box.innerHTML = `✅ Baseline: <b>${p.submitted.toLocaleString()}</b> submitted · <b>${p.errors.toLocaleString()}</b> with errors`; return; }
    const out = p.submitted - base.submitted, er = p.errors - base.errors;
    if (out < 0 || er < 0) { box.className = 'notice warn'; box.textContent = '⚠ These totals are lower than your start totals (new month, or the wrong page).'; return; }
    box.className = 'notice';
    box.innerHTML = `✅ Output this shift: <b>${out.toLocaleString()}</b> receipts · <b>${er.toLocaleString()}</b> with errors`;
  });
}

const PASTE_FIELD = `<div class="field"><label>ABUKAI PROCESSING STATS (PASTE HERE)</label><textarea name="stats" id="trkPaste" required placeholder="Statistics for … 381 submitted receipt(s) this month. 115 submitted receipt(s) with errors this month. …"></textarea></div><div id="trkPreview" class="notice">Waiting for the pasted stats…</div>`;

function startShift(accountId) {
  const a = data.accounts.find(x => x.id === accountId);
  if (!a) return toast('Account not found.');
  const sc = scheduleOf(profile);
  if (!inWindow(sc)) return toast(`You can only start during your scheduled shift (${sc.label}).`);
  const busy = activeShiftOf(a.id);
  if (busy) return toast(`${busy.workerName || 'Another worker'} is still working on this account.`);
  const scheduled = !!(sc && !sc.open);
  const day = defaultShiftDate(sc);
  const label = scheduled ? sc.label : (sc?.open ? sc.label : 'Open shift');
  if (scheduled && data.submissions.some(s => s.workerId === currentUser.uid && s.accountId === a.id && s.shiftDate === day && s.status !== 'rejected')) {
    return toast(`You already submitted this shift for ${a.name}. Ask your admin to "Allow resubmit" if it needs correcting.`);
  }

  openModal('Start shift · ' + a.name,
    `<ol class="muted" style="margin:0 0 12px;padding-left:18px;line-height:1.55"><li>Open the Abukai <b>Processing Stats</b> page.</li><li>Select all (Ctrl+A) and copy (Ctrl+C).</li><li>Paste it below.</li></ol>${PASTE_FIELD}`,
    async fd => {
      const raw = String(fd.get('stats') || '');
      const st = parseAbukaiStats(raw);
      if (!st) { toast('Could not read the Abukai stats. Copy the whole Processing Stats page and paste again.'); return false; }
      if (activeShiftOf(a.id)) { toast('Someone just started a shift on this account.'); return false; }
      if (!await confirmBox('Start shift?', `Start your shift on "${a.name}" with a baseline of ${st.submitted.toLocaleString()} submitted / ${st.errors.toLocaleString()} with errors? Nobody else can start this account until you end your shift.`, 'Yes, start shift')) return false;
      const item = { accountId: a.id, accountName: a.name, workerId: currentUser.uid, workerName: profile.displayName, shiftDate: day, shiftType: label, startStats: st, startRaw: raw.slice(0, 2000) };
      if (!configured) {
        data.activeShifts.push({ ...item, id: a.id, startedAt: new Date() });
        toast('Demo shift started (not saved online). Late errors cannot be tested in demo mode.');
        renderPage();
        return;
      }
      // Late errors: Abukai shows some errors only after a shift ended. The gap between the saved
      // "accounted" total of the last shift on this account and the new baseline is added to that last shift.
      let applied = null;
      try {
        const ref = fb.doc(db, 'activeShifts', a.id);
        const lref = fb.doc(db, 'accountLast', a.id);
        await fb.runTransaction(db, async tx => {
          const snap = await tx.get(ref);
          if (snap.exists()) throw new Error('busy');
          const ls = await tx.get(lref); // all reads first, then writes
          applied = null;
          if (ls.exists()) {
            const last = ls.data();
            const sameMonth = ymUTC(num(last.endedAtMs)) === ymUTC(Date.now()); // Abukai resets monthly, ignore across months
            const gap = st.errors - num(last.accounted);
            if (sameMonth && last.open !== false && last.submissionId && gap > 0) {
              const room = Math.max(0, num(last.receipts) - num(last.errors)); // errors can never be more than processed
              const add = Math.min(gap, room);
              if (add > 0) {
                tx.update(fb.doc(db, 'submissions', last.submissionId), {
                  errorCount: fb.increment(add),
                  lateErrors: fb.increment(add),
                  lateErrorsAt: fb.serverTimestamp(),
                  updatedAt: fb.serverTimestamp()
                });
              }
              // everything is now accounted for (even when capped) so it is never added twice
              tx.update(lref, { accounted: st.errors, errors: num(last.errors) + add, updatedAt: fb.serverTimestamp() });
              applied = { add, gap, who: last.workerName || 'worker', day: last.shiftDate, capped: add < gap };
            }
          }
          tx.set(ref, { ...item, startedAt: fb.serverTimestamp() });
        });
        if (applied && applied.add > 0) {
          logAudit('Late errors added to previous shift',
            `${applied.who} · ${a.name} · ${applied.day}: +${applied.add} error(s)${applied.capped ? ` (capped, gap was ${applied.gap})` : ''}`);
          toast(`Shift started. +${applied.add} late error(s) added to the previous shift (${applied.who}).`);
        } else {
          toast('Shift started. Do not forget to press End shift when you finish.');
        }
      } catch (e) {
        console.error(e);
        toast(e?.message === 'busy' ? 'Someone just started a shift on this account.' : 'Could not start the shift. Check Firestore rules (activeShifts / accountLast / submissions).');
        return false;
      }
    }, 'Start shift');
  liveStatsPreview('#trkPreview', null);
}

function endShift(accountId) {
  const s = activeShiftOf(accountId);
  if (!s || s.workerId !== currentUser.uid) return toast('You have no running shift on this account.');
  const sc = scheduleOf(profile);
  if (!inWindow(sc)) return toast(`You can only end and submit during your scheduled shift (${sc.label}). Ask the admin if you missed it.`);
  const base = s.startStats || { submitted: 0, errors: 0 };
  const startMs = timeVal(s.startedAt);
  // Abukai's monthly stats go back to zero at 8:00 AM Philippine time on the 1st of the month (= 00:00 UTC).
  const n0 = new Date();
  const resetMs = Date.UTC(n0.getUTCFullYear(), n0.getUTCMonth(), 1);
  const crossed = startMs < resetMs && Date.now() >= resetMs; // this shift ran across the monthly reset

  // Output of the shift. After a reset, "end" only counts what was submitted AFTER the reset,
  // so the part before the reset comes from the stats the worker copied just before 8:00 AM.
  const calc = (en, pre) => {
    if (!crossed) {
      const out = en.submitted - num(base.submitted), er = en.errors - num(base.errors);
      return out < 0 || er < 0 ? null : { count: out, errCount: er, partial: false };
    }
    if (!pre) return { count: en.submitted, errCount: en.errors, partial: true };
    const pOut = pre.submitted - num(base.submitted), pEr = pre.errors - num(base.errors);
    if (pOut < 0 || pEr < 0) return null;
    return { count: pOut + en.submitted, errCount: pEr + en.errors, partial: false };
  };

  const resetField = crossed
    ? `<div class="notice warn" style="margin-bottom:10px">⚠ Your shift went past the monthly reset (8:00 AM on the 1st), so the Abukai stats went back to zero. Paste below the stats you copied <b>just before 8:00 AM</b>. If you did not copy them, leave it empty: only the receipts after the reset are counted and the admin will add the rest.</div><div class="field"><label>STATS COPIED BEFORE 8:00 AM (RECOMMENDED)</label><textarea name="pre" id="trkPre" placeholder="Paste the stats you copied just before the 8:00 AM reset…"></textarea></div>`
    : '';

  openModal('End shift · ' + (s.accountName || ''),
    `<p class="muted" style="margin-top:0">Started ${esc(fmtTime(s.startedAt))} · baseline <b>${num(base.submitted).toLocaleString()}</b> submitted · <b>${num(base.errors).toLocaleString()}</b> with errors</p>
     <ol class="muted" style="margin:0 0 12px;padding-left:18px;line-height:1.55"><li>Open the Abukai <b>Processing Stats</b> page again.</li><li>Select all (Ctrl+A) and copy (Ctrl+C).</li><li>Paste it below.</li></ol>${resetField}${PASTE_FIELD}`,
    async fd => {
      const raw = String(fd.get('stats') || '');
      const en = parseAbukaiStats(raw);
      if (!en) { toast('Could not read the Abukai stats. Copy the whole Processing Stats page and paste again.'); return false; }
      const preRaw = crossed ? String(fd.get('pre') || '').trim() : '';
      const pre = preRaw ? parseAbukaiStats(preRaw) : null;
      if (preRaw && !pre) { toast('Could not read the stats you copied before 8:00 AM. Paste the whole Processing Stats page.'); return false; }
      const r = calc(en, pre);
      if (!r) { toast('These totals are lower than your start totals (wrong page?). Ask the admin to release this shift.'); return false; }
      const { count, errCount } = r;
      if (!inWindow(sc)) { toast('Your scheduled shift has already ended.'); return false; }
      const warn = (count === 0 ? ' Your output is 0, are you sure?' : '') + (r.partial ? ' The part before the 8:00 AM reset is missing, the admin will add it.' : '');
      if (!await confirmBox('End shift and submit?', `Output: ${count.toLocaleString()} receipts, ${errCount.toLocaleString()} with errors. This will be sent for admin review.${warn}`, 'Yes, submit', count === 0 || r.partial)) return false;

      const now = new Date();
      const rateCents = rate(), pct = dedPct();
      const gross = Math.round(count * rateCents);
      const ded = Math.round(gross * pct / 100);
      const resetNote = !crossed ? '' : (r.partial
        ? '⚠ Monthly reset (8:00 AM) happened during this shift. Only the receipts AFTER the reset were counted. The admin must add the part before it (use Edit counts).'
        : `Monthly reset (8:00 AM) happened during this shift. Stats before the reset: ${pre.submitted} submitted / ${pre.errors} errors.`);
      const item = {
        workerId: currentUser.uid, workerName: profile.displayName, workerEmail: currentUser.email,
        accountId: s.accountId || s.id, accountName: s.accountName || '',
        shiftDate: s.shiftDate, shiftType: s.shiftType || 'Open shift', startTime: hhmm(new Date(startMs)), endTime: hhmm(now),
        receiptCount: count, errorCount: errCount, errorNote: resetNote,
        status: 'pending', rejectionReason: '',
        rateCents, deductionPercent: pct,
        grossCents: gross, deductionCents: ded, netCents: gross - ded,
        source: 'abukai-paste',
        startStats: { submitted: num(base.submitted), errors: num(base.errors) }, endStats: en,
        startedAtMs: startMs, endedAtMs: now.getTime(),
        startRaw: String(s.startRaw || '').slice(0, 2000),
        endRaw: (preRaw ? raw.slice(0, 1000) + '\n--- STATS COPIED BEFORE THE 8:00 AM RESET ---\n' + preRaw.slice(0, 900) : raw).slice(0, 2000)
      };
      if (!configured) {
        data.submissions.unshift({ ...item, id: 'local-' + Date.now(), createdAt: new Date(), updatedAt: new Date() });
        data.activeShifts = data.activeShifts.filter(x => x.id !== s.id);
        toast('Demo shift submitted (not saved online).');
        renderPage();
        return;
      }
      try {
        const b = fb.writeBatch(db);
        const subRef = fb.doc(fb.collection(db, 'submissions'));
        b.set(subRef, { ...item, createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp() });
        // The next worker who starts on this account compares their baseline with "accounted" to find late errors.
        b.set(fb.doc(db, 'accountLast', item.accountId), {
          accountId: item.accountId, submissionId: subRef.id,
          workerId: currentUser.uid, workerName: profile.displayName, shiftDate: s.shiftDate,
          receipts: count, errors: errCount, // used as the cap (errors can never be more than receipts)
          accounted: en.errors,              // Abukai errors total that is already counted
          open: true, endedAtMs: now.getTime(), updatedAt: fb.serverTimestamp()
        });
        b.delete(fb.doc(db, 'activeShifts', s.id));
        await b.commit();
        const rt = errRatePct(count, errCount);
        toast(errCount > 0 && errWarnPct() > 0 && rt >= errWarnPct() ? `Shift submitted. ⚠ Your error rate for this shift is ${rt.toFixed(1)}% (limit ${errWarnPct()}%). Please double-check your work.` : 'Shift submitted for review.');
      } catch (e) {
        console.error(e);
        toast('Could not submit the shift. Check your connection and Firestore rules (submissions / activeShifts / accountLast).');
        return false;
      }
    }, 'End shift & submit');

  // live preview of the computed output
  const refresh = () => {
    const box = $('#trkPreview'), ta = $('#trkPaste');
    if (!box || !ta) return;
    const warn = t => { box.className = 'notice warn'; box.textContent = t; };
    const en = parseAbukaiStats(ta.value);
    if (!en) return warn('⚠ Could not read the stats. Copy the whole Abukai Processing Stats page and paste it again.');
    const preTxt = ($('#trkPre')?.value || '').trim();
    const pre = preTxt ? parseAbukaiStats(preTxt) : null;
    if (preTxt && !pre) return warn('⚠ Could not read the stats you copied before 8:00 AM.');
    const r = calc(en, pre);
    if (!r) return warn('⚠ These totals are lower than your start totals (wrong page?).');
    box.className = r.partial ? 'notice warn' : 'notice';
    box.innerHTML = `${r.partial ? '⚠ Only the receipts after the 8:00 AM reset are counted. ' : '✅ '}Output this shift: <b>${r.count.toLocaleString()}</b> receipts · <b>${r.errCount.toLocaleString()}</b> with errors`;
  };
  $('#trkPaste')?.addEventListener('input', refresh);
  $('#trkPre')?.addEventListener('input', refresh);
}

async function cancelShift(accountId) {
  const s = activeShiftOf(accountId);
  if (!s || s.workerId !== currentUser.uid) return;
  if (!await confirmBox('Cancel this shift?', 'Your start baseline will be discarded and nothing will be submitted. Use this only if you started by mistake.', 'Yes, cancel shift', true)) return;
  if (!configured) { data.activeShifts = data.activeShifts.filter(x => x.id !== s.id); renderPage(); return; }
  try {
    await fb.deleteDoc(fb.doc(db, 'activeShifts', s.id));
    toast('Shift cancelled.');
  } catch (e) { console.error(e); toast('Could not cancel the shift. Check Firestore rules.'); }
}

async function releaseShift(accountId) {
  if (!isAdmin()) return;
  const s = activeShiftOf(accountId);
  if (!s) return;
  if (!await confirmBox('Release this shift?', `${s.workerName || 'The worker'}'s running shift on "${s.accountName || 'this account'}" will be cancelled and nothing will be submitted. The account becomes free for others.`, 'Yes, release', true)) return;
  const info = `${s.workerName || 'Worker'} · ${s.accountName || s.id} · started ${date(s.startedAt)} ${fmtTime(s.startedAt)}`;
  if (!configured) { data.activeShifts = data.activeShifts.filter(x => x.id !== s.id); logAudit('Released running shift', info); renderPage(); return; }
  try {
    await fb.deleteDoc(fb.doc(db, 'activeShifts', s.id));
    logAudit('Released running shift', info);
    toast('Shift released.');
  } catch (e) { console.error(e); toast('Could not release the shift. Check Firestore rules.'); }
}

function receipts() {
  const rows = filteredSubmissions();
  const sel = v => filters.status === v ? 'selected' : '';
  return `<div class="welcome"><div><h2>${isAdmin() ? 'Review submissions' : 'My shifts'}</h2><p>${isAdmin() ? 'Review worker activity, edit processed/error counts, and approve or reject shift records.' : 'Start and end your shift here, and track the status of your submissions.'}</p></div>${!isAdmin() ? '<button class="btn btn-primary" id="newSubmission">▶ Shift tracker</button>' : ''}</div>${!isAdmin() ? trackerPanel() : activeShiftsPanel()}<div class="panel"><div class="toolbar"><input id="receiptSearch" placeholder="Search worker or account…" value="${esc(filters.q)}"><select id="statusFilter"><option value="all">All statuses</option><option ${sel('pending')}>pending</option><option ${sel('approved')}>approved</option><option ${sel('rejected')}>rejected</option></select><label class="muted date-f">From <input type="date" id="subFrom" value="${esc(filters.from)}" max="${esc(filters.to || todayStr())}"></label><label class="muted date-f">To <input type="date" id="subTo" value="${esc(filters.to)}" min="${esc(filters.from)}" max="${todayStr()}"></label>${filters.from || filters.to ? '<button type="button" class="small-btn" id="clearDates">Clear dates</button>' : ''}<span class="spacer"></span><span class="muted" id="recordCount">${rows.length} record(s)</span><button type="button" class="small-btn" id="exportFiltered" title="Download the records matching the current search, status and dates">↓ Export CSV</button></div><div class="table-wrap"><table><thead><tr><th>Worker / account</th><th>Shift date</th><th>Shift</th><th>Processed</th><th>Errors</th><th>Net pay</th><th>Status</th><th>Action</th></tr></thead><tbody id="submissionRows">${submissionRowsPaged(rows)}</tbody></table></div></div>`;
}

function workerNamesFor(a) {
  const byId = new Map(data.users.map(u => [u.id, u.displayName || u.email]));
  const names = (a.assignedWorkerIds || []).map((id, i) => byId.get(id) || a.assignedWorkerNames?.[i]).filter(Boolean);
  return names.length ? names.join(', ') : 'Not assigned';
}

/* Monthly receipt/error totals per account (rejected submissions are excluded) */
// Abukai's monthly stats reset at 8:00 AM Philippine time on the 1st (= 00:00 UTC). So the "month" in this app follows that
// reset, not the calendar: a shift belongs to the Abukai month in which it ENDED.
const ymUTC = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const monthOf = s => (s && s.endedAtMs) ? ymUTC(num(s.endedAtMs)) : String((s && s.shiftDate) || '').slice(0, 7); // old manual entries keep their shift date
function monthKeyOf(offset = 0) {
  const n = new Date();
  return ymUTC(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset, 1));
}
const workerWinMonth = () => monthKeyOf(-(WORKER_SUB_MONTHS - 1));
const subWindowMonth = () => monthKeyOf(-(SUB_WINDOW_MONTHS - 1)); // e.g. '2026-09' in Nov 2026
const monthLabel = k => {
  const [y, m] = k.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
};
function accountStats(accountId) {
  const cur = monthKeyOf(0), prev = monthKeyOf(-1);
  const r = { cur: { receipts: 0, errors: 0 }, prev: { receipts: 0, errors: 0 } };
  data.submissions.forEach(s => {
    if (s.accountId !== accountId || s.status !== 'approved') return;
    const k = monthOf(s);
    const b = k === cur ? r.cur : k === prev ? r.prev : null;
    if (!b) return;
    b.receipts += num(s.receiptCount);
    b.errors += num(s.errorCount);
  });
  return r;
}

function accounts() {
  const curLabel = monthLabel(monthKeyOf(0)), prevLabel = monthLabel(monthKeyOf(-1));
  const rows = data.accounts.map(a => ({ a, st: accountStats(a.id) }));
  const tot = rows.reduce((t, x) => {
    t.pr += x.st.prev.receipts; t.pe += x.st.prev.errors;
    t.cr += x.st.cur.receipts; t.ce += x.st.cur.errors;
    return t;
  }, { pr: 0, pe: 0, cr: 0, ce: 0 });
  const errCell = n => `<td${n > 0 ? ' style="color:#c0392b;font-weight:600"' : ''}>${n.toLocaleString()}</td>`;

  const body = rows.map(({ a, st }) => `<tr><td><strong>${esc(a.name)}</strong></td><td>${esc(a.code || '—')}</td><td>${esc(workerNamesFor(a))}</td><td>${st.prev.receipts.toLocaleString()}</td>${errCell(st.prev.errors)}<td>${st.cur.receipts.toLocaleString()}</td>${errCell(st.cur.errors)}<td>${status(a.isActive === false ? 'inactive' : 'active')}</td><td>${esc(a.notes || '—')}</td><td>${isAdmin() ? `<div class="sh-row-actions"><button class="btn btn-secondary" data-assign="${esc(a.id)}">Assign workers</button><button class="small-btn" data-edit-account="${esc(a.id)}">Edit</button><button class="small-btn" data-toggle-account="${esc(a.id)}">${a.isActive === false ? 'Activate' : 'Deactivate'}</button><button class="btn btn-danger" data-delete-account="${esc(a.id)}">Delete</button></div>` : '—'}</td></tr>`).join('');

  const foot = `<tr style="font-weight:700;background:rgba(0,0,0,.03)"><td colspan="3">Total (all accounts)</td><td>${tot.pr.toLocaleString()}</td>${errCell(tot.pe)}<td>${tot.cr.toLocaleString()}</td>${errCell(tot.ce)}<td colspan="3"></td></tr>`;

  return `<div class="welcome"><div><h2>Accounts</h2><p>Abukai accounts, worker assignments, and monthly receipt totals.</p></div>${isAdmin() ? '<button class="btn btn-primary" id="addAccount">＋ Add account</button>' : ''}</div><div class="panel">${data.accounts.length ? `<div class="table-wrap"><table><thead><tr><th colspan="3"></th><th colspan="2" style="text-align:center">Last month · ${esc(prevLabel)}</th><th colspan="2" style="text-align:center">This month · ${esc(curLabel)}</th><th colspan="3"></th></tr><tr><th>Account</th><th>Code</th><th>Assigned workers</th><th>Receipts</th><th>Errors</th><th>Receipts</th><th>Errors</th><th>Status</th><th>Notes</th><th>Action</th></tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div><div class="notice" style="margin-top:12px">Totals use the shift date and count processed receipts and errors from approved submissions only. Pending and rejected submissions are not counted.</div>` : `<div class="empty"><span class="empty-ico">${EMPTY_ICONS.accounts}</span><b>No accounts available</b>Ask an administrator to create an account and assign workers.</div>`}</div>`;
}

/* ───────────────────────── Error processed ───────────────────────── */
function errorsPage() {
  const all = visibleSubmissions().filter(s => s.status === 'approved');
  const rows = all.filter(s => num(s.errorCount) > 0).sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt));
  const totalErr = rows.reduce((n, s) => n + num(s.errorCount), 0);
  const totalProcessed = all.reduce((n, s) => n + num(s.receiptCount), 0);
  const overall = totalProcessed > 0 ? (totalErr / totalProcessed * 100).toFixed(1) : '0.0';

  const body = rows.length ? rows.map(s => {
    const p = num(s.receiptCount), er = num(s.errorCount);
    const rt = p > 0 ? (er / p * 100).toFixed(1) : '0.0';
    return `<tr><td><div class="person"><div class="avatar">${esc(initials(s.workerName))}</div><div><strong>${esc(s.workerName || 'Worker')}</strong><small>${esc(s.accountName || 'No account')}</small></div></div></td><td>${esc(date(s.shiftDate))}</td><td>${esc(s.shiftType || '—')}</td><td>${p.toLocaleString()}</td><td style="color:#c0392b;font-weight:600">${er.toLocaleString()}</td><td${errWarnPct() > 0 && errRatePct(p, er) >= errWarnPct() ? ' style="color:#c0392b;font-weight:600"' : ''}>${rt}%${errWarnPct() > 0 && errRatePct(p, er) >= errWarnPct() ? ' ⚠' : ''}</td><td>${esc(s.errorNote || '—')}</td><td>${status(s.status)}</td><td><div class="sh-row-actions"><button class="small-btn" data-view="${esc(s.id)}">View</button>${isAdmin() ? rowAdminBtns(s) : ''}</div></td></tr>`;
  }).join('') : `<tr><td colspan="9"><div class="empty"><span class="empty-ico">${EMPTY_ICONS.check}</span><b>No errors recorded</b>Submissions with an error count above zero will appear here.</div></td></tr>`;

  return `<div class="welcome"><div><h2>${isAdmin() ? 'Error processed' : 'My error processed'}</h2><p>${isAdmin() ? 'Shifts with error receipts. Use Edit to correct processed or error counts.' : 'Shifts where you recorded error receipts.'}</p></div></div><div class="stats">${stat('Total errors', totalErr.toLocaleString(), 'Across listed submissions', '⚠')}${stat('Shifts with errors', rows.length, `of ${all.length} submission(s)`, '▤')}${stat('Error rate', overall + '%', 'Errors ÷ processed (errors are included in processed)', '%')}${stat('Processed receipts', totalProcessed.toLocaleString(), 'Basis of pay (includes error receipts)', '✓')}</div><div class="panel"><div class="table-wrap"><table><thead><tr><th>Worker / account</th><th>Shift date</th><th>Shift</th><th>Processed</th><th>Errors</th><th>Error rate</th><th>Note</th><th>Status</th><th>Action</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function reports() {
  const rows = visibleSubmissions().filter(inReportRange);
  const approved = rows.filter(s => s.status === 'approved');
  const gross = approved.reduce((n, s) => n + num(s.grossCents), 0);
  const deduct = approved.reduce((n, s) => n + num(s.deductionCents), 0);
  const net = approved.reduce((n, s) => n + num(s.netCents), 0);
  const months = {};
  approved.forEach(s => { const k = monthOf(s) || 'Unknown'; months[k] = (months[k] || 0) + num(s.netCents); });
  const max = Math.max(1, ...Object.values(months));

  let perWorker = '';
  if (isAdmin()) {
    const g = {};
    approved.forEach(s => {
      const k = s.workerId || s.workerName || 'unknown';
      g[k] ||= { key: k, name: s.workerName || 'Worker', shifts: 0, receipts: 0, net: 0 };
      g[k].shifts++; g[k].receipts += num(s.receiptCount); g[k].net += num(s.netCents);
    });
    const list = Object.values(g).sort((a, b) => b.net - a.net);
    perWorker = `<div class="panel"><div class="panel-head"><div><h3>By worker</h3><p>Approved shifts only</p></div></div><div class="table-wrap"><table><thead><tr><th>Worker</th><th>Shifts</th><th>Receipts</th><th>Net pay</th><th></th></tr></thead><tbody>${list.map(w => `<tr><td><strong>${esc(w.name)}</strong></td><td>${w.shifts}</td><td>${w.receipts.toLocaleString()}</td><td>${money(w.net)}</td><td><button class="small-btn" data-payslip="${esc(w.key)}">Print payslip</button></td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">No approved shifts yet.</div></td></tr>'}</tbody></table></div></div>`;
  }

  return `<div class="welcome"><div><h2>${isAdmin() ? 'Team reports' : 'My earnings'}</h2><p>Approved submissions only are included in pay totals.${reportFrom || reportTo ? ` Showing shifts from ${esc(reportFrom ? date(reportFrom) : 'the start')} to ${esc(reportTo ? date(reportTo) : 'today')}.` : ''}</p></div><div class="welcome-actions"><label class="muted date-f">From <input type="date" id="repFrom" value="${esc(reportFrom)}" max="${esc(reportTo || todayStr())}"></label><label class="muted date-f">To <input type="date" id="repTo" value="${esc(reportTo)}" min="${esc(reportFrom)}" max="${todayStr()}"></label>${reportFrom || reportTo ? '<button type="button" class="small-btn" id="repClear">Clear dates</button>' : ''}${payslipMonthSelect(approved)}${isAdmin() ? '' : '<button class="btn btn-primary" id="printPayslip">⎙ Print payslip</button>'}<button class="btn btn-ghost" id="exportCsv">↓ Export CSV</button></div></div><div class="stats">${stat('Gross pay', money(gross), 'Before deductions', '₱')}${stat('Deductions', money(deduct), `${dedPct()}% configured rate`, '−')}${stat('Net payable', money(net), 'Approved records', '✓')}${stat('Approved shifts', approved.length, 'Completed and approved', '▤')}</div><div class="grid-2"><div class="panel"><div class="panel-head"><div><h3>Monthly net pay</h3><p>By shift date, approved submissions</p></div></div><div class="report-bars">${Object.entries(months).sort((a, b) => a[0].localeCompare(b[0])).slice(-8).map(([m, v]) => `<div class="bar-line"><span>${esc(m)}</span><div class="bar-track"><div class="bar-fill" style="width:${(v / max * 100).toFixed(1)}%"></div></div><b>${money(v)}</b></div>`).join('') || '<div class="empty">No approved earnings to chart yet.</div>'}</div></div><div class="panel"><div class="panel-head"><div><h3>Calculation details</h3><p>Based on current pay settings</p></div></div><div class="right" style="justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--line)"><span class="muted">Rate per receipt</span><b>${money(rate())}</b></div><div class="right" style="justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--line)"><span class="muted">Deduction rate</span><b>${dedPct()}%</b></div><div class="right" style="justify-content:space-between;padding:14px 0"><span class="muted">Net after deductions</span><b>${money(net)}</b></div><div class="notice">Totals update from Firestore when Firebase is configured. Demo data is illustrative only.</div></div></div>${perWorker}`;
}

const agreementLabel = u => u.agreement?.version === AGREEMENT_VERSION
  ? `✅ Accepted ${date(u.agreement.acceptedAt)}`
  : (u.agreement ? '⚠ Old version, must re-accept' : '⏳ Not yet accepted');
function workers() {
  const users = liveUsers().filter(u => u.role !== 'admin');
  const actions = u => {
    const st = u.status || 'approved';
    const b = [`<button class="small-btn" data-worker="${esc(u.id)}">View</button>`, `<button class="small-btn" data-worker-action="edit" data-id="${esc(u.id)}">Edit</button>`, `<button class="small-btn" data-worker-action="schedule" data-id="${esc(u.id)}">Shift</button>`];
    if (st === 'pending' || st === 'rejected') b.push(`<button class="small-btn" data-worker-action="approve" data-id="${esc(u.id)}">Approve</button>`);
    if (st === 'pending') b.push(`<button class="small-btn" data-worker-action="reject" data-id="${esc(u.id)}">Reject</button>`);
    if (st === 'approved') b.push(u.isActive === false
      ? `<button class="small-btn" data-worker-action="activate" data-id="${esc(u.id)}">Activate</button>`
      : `<button class="small-btn" data-worker-action="deactivate" data-id="${esc(u.id)}">Deactivate</button>`);
    b.push(`<button class="btn btn-danger" data-worker-action="delete" data-id="${esc(u.id)}">Delete</button>`);
    return `<div class="sh-row-actions">${b.join('')}</div>`;
  };
  return `<div class="welcome"><div><h2>Worker management</h2><p>Review worker profiles and account status.</p></div><button class="btn btn-primary" id="addWorker">＋ Create worker</button></div><div class="panel"><div class="toolbar"><input id="workerSearch" placeholder="Search name or email…"><span class="spacer"></span><span class="muted">${users.length} worker(s)</span></div><div class="table-wrap"><table><thead><tr><th>Worker</th><th>Email</th><th>Status</th><th>Assigned accounts</th><th>Shift schedule</th><th>Agreement</th><th>Action</th></tr></thead><tbody>${users.map(u => `<tr><td><div class="person"><div class="avatar">${esc(initials(u.displayName))}</div><strong>${esc(u.displayName || 'Unnamed')}</strong></div></td><td>${esc(u.email)}</td><td>${status(u.isActive === false ? 'inactive' : (u.status || 'approved'))}</td><td>${(u.assignedAccountIds || []).length}</td><td>${esc(scheduleOf(u)?.label || 'Not set')}</td><td>${esc(agreementLabel(u))}</td><td>${actions(u)}</td></tr>`).join('') || '<tr><td colspan="7"><div class="empty">No worker profiles found.</div></td></tr>'}</tbody></table></div></div>`;
}

function settings() {
  return `<div class="welcome"><div><h2>Pay settings</h2><p>Configure receipt rate and deductions for future submissions.</p></div></div><div class="panel" style="max-width:650px"><form id="settingsForm"><div class="field"><label>GROSS RATE PER RECEIPT (PHP)</label><input name="rate" type="number" min="0" step="0.01" value="${(rate() / 100).toFixed(2)}" required></div><div class="field"><label>DEDUCTION PERCENT (%)</label><input name="deduction" type="number" min="0" max="100" step="0.1" value="${dedPct()}" required></div><div class="field"><label>ERROR RATE WARNING (%)</label><input name="errWarn" type="number" min="0" max="100" step="0.1" value="${errWarnPct()}" required></div><div class="field"><label>WORK WEBSITE LINK ("START WORK" BUTTON FOR WORKERS)</label><input name="workUrl" type="url" placeholder="https://…" value="${esc(data.settings.workUrl || '')}"></div><div class="notice">These values are used for new submissions. Updating settings does not automatically recalculate historical submissions.</div><button class="btn btn-primary" type="submit">Save settings</button></form></div>`;
}

function chatBubbles() {
  const messages = (chatConv === 'dm' ? data.dmMessages : data.messages) || [];
  return messages.map(m => {
    const mine = m.senderId === currentUser?.uid;
    return `<div class="bubble ${mine ? 'mine' : ''}">${!mine ? `<b>${esc(m.senderName || 'Team member')}</b><br>` : ''}${esc(m.text || m.message || '')}<small>${esc(fmtTime(m.createdAt))}</small></div>`;
  }).join('') || '<div class="empty"><span class="empty-ico">${EMPTY_ICONS.chat}</span><b>No messages yet</b>Start the conversation with your team.</div>';
}
function updateChat() {
  const box = $('#chatMessages');
  if (!box) return;
  const lst = $('#chatList');
  if (lst) lst.innerHTML = chatListHtml();
  markDmRead();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const lastMine = ((chatConv === 'dm' ? data.dmMessages : data.messages) || []).slice(-1)[0]?.senderId === currentUser?.uid;
  box.innerHTML = chatBubbles();
  if (nearBottom || lastMine) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
}
function chat() {
  if (isAdmin() && chatConv === 'dm' && !dmWith) chatConv = 'group';
  const who = chatConv === 'group' ? 'Public group: everyone can read these messages.' : (isAdmin() ? `Private chat with ${esc(chatPeerName())}: only you and this worker can read it.` : 'Private chat with the admin: only you and the admin can read it.');
  return `<div class="welcome"><div><h2>Team conversation</h2><p>${who}</p></div></div><div class="chat-layout"><div class="chat-list" id="chatList">${chatListHtml()}</div><div class="chat-window"><div class="chat-messages" id="chatMessages">${chatBubbles()}</div><form class="chat-compose" id="chatForm"><input name="message" placeholder="${chatConv === 'group' ? 'Message the whole team…' : 'Write a private message…'}" maxlength="2000" autocomplete="off" required><button class="btn btn-primary" type="submit">Send ↗</button></form></div></div>`;
}

/* ───────────────────────── User agreement (must accept before using the app) ───────────────────────── */
const AGREEMENT_VERSION = '2026-10-31'; // change this when you edit the text → everyone must accept again

const AGREEMENT = {
  title: 'STEIVY RECEIPTS CORRECTOR',
  subtitle: 'CONSULTANT PROPRIETARY INFORMATION AND NONDISCLOSURE AGREEMENT',
  date: 'October 31, 2026',
  address: ['Steivy Receipts Corrector', '147 Acha Street', 'Pagina Jagna 6308', 'Bohol Philippines'],
  intro: 'The following contains all the terms of my Consulting Agreement (the “Agreement”) with Steivy Receipts Corrector (an Independent Contractor under Abukai, Inc.) supersedes all other understandings, oral or written, between us:',
  items: [
    'The amount of time I will spend as a sub-contractor to the Independent Contractor, the nature of the services provided (the “Services”) and my compensation are set forth on Exhibit A.',
    'I recognize that it is the express intention of the parties to this Agreement that I work as a sub-contractor, an not an employee, agent, joint venturer, or partner of the Independent Contractor. Nothing in the Agreement shall be interpreted or construed as creating or establishing an employment relationship between the Independent Contractor and myself. I hereby represent that; (i) I am acting solely as a sub-contractor of the Independent Contractor which is under Abukai Inc.; (ii) Steivy Receipts Corrector nor Abukai Inc. has no obligation to me under any law regarding employee liability; and (iii) the only liability of Steivy Receipts Corrector in connection to this Agreement is limited to any commission paid. In addition, I acknowledge that I shall not receive not be entitled to overtime pay, insurance, paid vacation, severance payments or similar fringe or employment benefits of any kind from Steivy Receipt Corrector and Abukai Inc.',
    'I recognize that I will have no authority to act on or enter into any contract or understanding, incur any liability or make any representation on behalf of Steivy Receipts Corrector without first obtaining specific written instructions from them.',
    'I recognized that I am solely responsible for all taxes, withholdings, VAT, fees, penalties, and other similar statutory obligations. I agree to defend, indemnify and hold Steivy Receipts Corrector harmless from any and all claims made by an entity on account of an alleged failure by me to satisfy any such tax, or withholding obligation.',
    'I will supply any tools and equipment necessary to perform the Services.',
    'Should I, in my sole discretion, deem it necessary to employ assistants to aid me in the performance of the Services, I agree that Steivy Receipts Corrector will not direct, supervise, or control in any way such assistants in their performance of Services. I further agree that such assistants are employed solely by me, and that I alone am responsible for paying the salaries and wages of my employees.',
    'I will indemnify and hold Steivy Receipts Corrector harmless from, and will defend them against, any and all loss, liability, damage, claims, demands, or suits and related costs and expenses to persons or property that arise, directly or indirectly, from my acts or omissions, or from the breech of any term or condition of this Agreement attributable to me or my agents.',
    'I understand that my consulting relationship creates a relationship of confidence and trust between me and Steivy Receipts Corrector.',
    'During my consulting relationship, I will not engage in any business activity which is related to the subject matter of my consulting.',
    'This Agreement may be terminated by either the Independent Contractor (Steivy Receipts Corrector) or myself at any time by giving (5) days’ written notice of termination. Such notice may be given any time for any reason, with or without cause. Termination of this Agreement will not affect the obligations of either party arising out of events or circumstances occurring prior to such termination.',
    'That I understand, I am not connected to Abukai Inc. but as independent sub-contractor of Steivy Receipt Corrector.'
  ],
  exhibitTitle: 'EXHIBIT A',
  duties: [
    'Conduct quality review of receipts and invoices through ABUKAI’s internal review tools.',
    'Accurately correct or enhance data as needed, based on the customer receipt and invoice and provided meta-information through ABUKAI’s internal review tools. Data may include the amount, date, vendor name, currency, city, state, country, flight itineraries and dates, hotel details (e.g. daily rate, Internet, phone, other expenses, meals, etc. ), parking dates, rental car dates, mileage information and itineraries, VAT amounts or % as might be required, cost category, additional details (e.g. lunch vs. breakfast vs. snack vs. drinks) and/or other data as required by ABUKAI’s systems and approach. The data required and tools provides are subject to change as ABUKAI deems fit.',
    'Participate in STEIVY RECIEPT CORRECTOR training sessions as required to learn how to best utilize ABUKAI’s tools an understand the expectation for data completeness, accuracy and quality.'
  ],
  compensationIntro: 'Compensation. As consideration for the Services, STEIVY RECEIPT CORRECTOR will pay to you the following amounts, without duplication:',
  compensation: [
    '1 php per Receipt accurately reviewed and corrected, as evaluated by ABUKAI.',
    'Ten percent (10%) of my total output (the total compensation computed under this Exhibit A) will be deducted as a service charge / transfer fee for the transfer of payment from ABUKAI to PayPal.',
    'The remaining amount after the 10% deduction will then be sent to me through my chosen online account, such as GCash, Maya, a bank account, or GoTyme.',
    'I am solely responsible for providing complete and correct details of my chosen online account (account name, account number, and mobile number or bank details). STEIVY RECEIPT CORRECTOR will not be liable for any delay, loss, or failed or wrong transfer caused by incorrect, incomplete, or outdated account details that I provided, and any additional fees charged by the receiving bank or e-wallet will be shouldered by me.'
  ],
  compensationNote: 'Payments will be earned and paid monthly, based on the volume of receipts reviewed and corrected by Consultant/ Independent sub-contractor the previous month.'
};

const needsAgreement = () => !!currentUser && !!profile && profile.agreement?.version !== AGREEMENT_VERSION;

function agreementBodyHtml() {
  const A = AGREEMENT;
  return `<div style="text-align:center;font-weight:700;line-height:1.5">${esc(A.title)}<br>${esc(A.subtitle)}</div>
    <p style="text-align:center;margin:14px 0">${esc(A.date)}</p>
    <p style="margin:0 0 14px;line-height:1.5">${A.address.map(esc).join('<br>')}</p>
    <p>Gentlemen:</p>
    <p style="line-height:1.55">${esc(A.intro)}</p>
    <ol style="padding-left:22px;line-height:1.55">${A.items.map(t => `<li style="margin-bottom:12px">${esc(t)}</li>`).join('')}</ol>
    <hr style="margin:20px 0;border:0;border-top:1px solid #d5ddd8">
    <div style="text-align:center;font-weight:700;margin-bottom:12px">${esc(A.exhibitTitle)}</div>
    <p><b>1. Duties and Responsibilities</b></p>
    <ul style="padding-left:22px;line-height:1.55">${A.duties.map(t => `<li style="margin-bottom:10px">${esc(t)}</li>`).join('')}</ul>
    <p><b>2. ${esc(A.compensationIntro)}</b></p>
    <ul style="padding-left:22px;line-height:1.55">${A.compensation.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    <p style="line-height:1.55">${esc(A.compensationNote)}</p>
    <p class="muted" style="margin-top:18px">— End of agreement —</p>`;
}

function renderAgreement() {
  if ($('#agreementScreen')) return; // never rebuild while the user is reading/typing
  $('#app').innerHTML = `<div id="agreementScreen" class="sh-modal" style="z-index:2000;background:#f4f7f5"><div class="sh-modal-card" style="max-width:780px" role="dialog" aria-modal="true">
    <h3 style="margin-bottom:6px">User agreement</h3>
    <p class="muted" style="margin:0 0 12px">Please read the whole agreement below. You must accept it before you can use Steivy Receipt Hub.</p>
    <div id="agrBox" tabindex="0" style="height:52vh;overflow:auto;border:1px solid #d5ddd8;border-radius:12px;padding:16px;background:#fff;font-size:14px">${agreementBodyHtml()}</div>
    <div id="agrHint" class="notice warn" style="margin-top:12px">⬇ Scroll to the bottom to continue.</div>
    <label class="sh-check" style="border-bottom:0;opacity:.5" id="agrCheckWrap"><input type="checkbox" id="agrCheck" disabled><span>I have read, understood, and agree to this agreement.</span></label>
    <div class="field"><label>TYPE YOUR FULL NAME AS YOUR SIGNATURE</label><input id="agrName" maxlength="80" autocomplete="name" placeholder="Full name" value="${esc(profile?.displayName || '')}"></div>
    <div class="sh-modal-actions"><button type="button" class="btn btn-ghost" id="agrOut">↪ Sign out</button><button type="button" class="btn btn-primary" id="agrOk" disabled>Accept &amp; continue →</button></div>
  </div></div>`;

  const box = $('#agrBox'), chk = $('#agrCheck'), nameEl = $('#agrName'), ok = $('#agrOk');
  const refresh = () => { ok.disabled = !(chk.checked && nameEl.value.trim().length >= 2); };
  const checkScroll = () => {
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 8) {
      chk.disabled = false;
      $('#agrCheckWrap').style.opacity = '1';
      $('#agrHint')?.remove();
      box.removeEventListener('scroll', checkScroll);
    }
  };
  box.addEventListener('scroll', checkScroll);
  checkScroll();
  chk.addEventListener('change', refresh);
  nameEl.addEventListener('input', refresh);
  $('#agrOut').addEventListener('click', agreementSignOut);
  ok.addEventListener('click', () => { ok.disabled = true; acceptAgreement(nameEl.value.trim(), ok); });
}

async function acceptAgreement(signedName, btn) {
  const rec = { version: AGREEMENT_VERSION, signedName };
  const showErr = msg => {
    let el = $('#agrErr');
    if (!el) {
      el = document.createElement('div');
      el.id = 'agrErr';
      el.className = 'notice warn';
      el.style.marginTop = '12px';
      btn.closest('.sh-modal-actions').before(el);
    }
    el.textContent = msg;
  };
  if (!configured) {
    profile.agreement = { ...rec, acceptedAt: new Date() };
    finishAgreement();
    return;
  }
  try {
    await fb.updateDoc(fb.doc(db, 'users', currentUser.uid), {
      agreement: { ...rec, acceptedAt: fb.serverTimestamp() },
      updatedAt: fb.serverTimestamp()
    });
    profile.agreement = { ...rec, acceptedAt: new Date() };
    finishAgreement();
  } catch (e) {
    console.error('agreement save failed', e);
    const code = e?.code || 'unknown';
    showErr(code === 'permission-denied'
      ? 'Could not save: Firestore blocked it (permission-denied). Ask the admin to publish the Firestore rule that lets a user update their own "agreement" field.'
      : code === 'unavailable'
        ? 'No internet connection. Please try again.'
        : 'Could not save your acceptance (' + code + '). Please try again.');
    btn.disabled = false;
  }
}

function finishAgreement() {
  renderPage();
  showShiftWarning();
  toast('Thank you. You can now use the website.');
}

async function agreementSignOut() {
  await stopPresence();
  unlisten();
  if (configured && auth) { try { await fb.signOut(auth); } catch {} }
  currentUser = null; profile = null; page = 'dashboard'; detailId = null;
  renderLogin();
}

/* ───────────────────────── Render + wiring ───────────────────────── */
function renderPage() {
  if (!currentUser || !profile) { renderLogin(); return; }
  if (needsAgreement()) { renderAgreement(); return; }
  pendingRender = false;
  if (!allowedPages().includes(page)) page = 'dashboard';
  if (page === 'chat') unreadChat = 0;
  $('#app').innerHTML = shell();
  $('#pageContent').innerHTML = accessBanner() + ({ dashboard, receipts, errors: errorsPage, accounts, reports, chat, coworkers: coworkersPage, peerwatch: peerWatchPage, workers, settings, missed: missedPage, audit: auditPage })[page]();
  wireShell();
  wirePage();
  if (page === 'chat') markDmRead();
  if (page === 'coworkers') { startPresenceListen(); startStatsListen(); if (peerSel && !peerMsgUnsub) startPeerMsgs(); markPeerRead(); }
  if (page === 'peerwatch') startWatch();
  if (detailId) { const s = visibleSubmissions().find(x => x.id === detailId); if (s) viewSubmission(s.id, false); else detailId = null; }
  syncAnnouncementPopup();
  maybeShowWhatsNew();
}

function go(p) {
  if (page === 'coworkers' && p !== 'coworkers') stopPeerMsgs(); // no open message listener while on another page
  page = p;
  detailId = null;
  if (p === 'chat') unreadChat = 0;
  if (p === 'audit') { if (isAdmin() && !auditUnsub) startAudit(); } else stopAudit(); // no audit listener on other pages
  if (p === 'coworkers') { startPresenceListen(); startStatsListen(); } else { stopPresenceListen(); stopStatsListen(); } // online status and team totals are read only on the Co-workers page
  if (p === 'peerwatch') startWatch(); // normally already running since login
  renderPage();
  window.scrollTo(0, 0);
}

function wireShell() {
  $$('.nav button, .bottom-nav button[data-nav]').forEach(b => b.addEventListener('click', () => go(b.dataset.nav)));
  $('#moreBtn')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  const doLogout = async () => {
    await stopPresence();
    unlisten();
    if (configured && auth) { try { await fb.signOut(auth); } catch {} }
    currentUser = null; profile = null; page = 'dashboard'; detailId = null;
    renderLogin();
  };
  $('#logout')?.addEventListener('click', doLogout);
  $('#logoutTop')?.addEventListener('click', doLogout);
  $('#themeBtn')?.addEventListener('click', toggleTheme);
  $('#menuBtn')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#pageContent').addEventListener('click', e => {
    const t = e.target;
    let el;
    if ((el = t.closest('[data-lb-period]'))) { lbPeriod = el.dataset.lbPeriod; return renderPage(); }
    if ((el = t.closest('[data-perf-view]'))) { perfView = el.dataset.perfView === 'totals' ? 'totals' : 'top'; return renderPage(); }
    if (t.closest('[data-review-pending]')) { filters.status = 'pending'; filters.q = ''; filters.from = ''; filters.to = ''; subLimit = 50; return go('receipts'); }
    if ((el = t.closest('[data-page]'))) return go(el.dataset.page);
    if ((el = t.closest('[data-start-shift]'))) { if (el.disabled) return; return startShift(el.dataset.startShift); }
    if ((el = t.closest('[data-end-shift]'))) return endShift(el.dataset.endShift);
    if ((el = t.closest('[data-cancel-shift]'))) return cancelShift(el.dataset.cancelShift);
    if ((el = t.closest('[data-release-shift]'))) return releaseShift(el.dataset.releaseShift);
    if ((el = t.closest('[data-payslip]'))) return printPayslip(el.dataset.payslip);
    if ((el = t.closest('[data-view]'))) return viewSubmission(el.dataset.view);
    if ((el = t.closest('[data-peer]'))) return openPeer(el.dataset.peer);
    if ((el = t.closest('[data-watch]'))) return openWatch(el.dataset.watch);
    if ((el = t.closest('[data-chat-conv]'))) return openChat(el.dataset.chatConv, el.dataset.chatId);
    if ((el = t.closest('[data-more-subs]'))) { subLimit += 50; return filterRows(); }
    if ((el = t.closest('[data-allow-resubmit]'))) return allowResubmit(el.dataset.allowResubmit);
    if ((el = t.closest('[data-edit-counts]'))) return editCounts(el.dataset.editCounts);
    if ((el = t.closest('[data-del-announcement]'))) return removeAnnouncement(el.dataset.delAnnouncement);
    if ((el = t.closest('[data-worker]'))) return viewWorker(el.dataset.worker);
    if ((el = t.closest('[data-assign]'))) return assignWorker(el.dataset.assign);
    if ((el = t.closest('[data-edit-account]'))) return editAccount(el.dataset.editAccount);
    if ((el = t.closest('[data-delete-account]'))) return deleteAccount(el.dataset.deleteAccount);
    if ((el = t.closest('[data-toggle-account]'))) return toggleAccount(el.dataset.toggleAccount);
    if ((el = t.closest('[data-worker-action]'))) return workerAction(el.dataset.id, el.dataset.workerAction);
  });
}

function wirePage() {
  $('#newSubmission')?.addEventListener('click', () => $('#submissionFormPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('#receiptSearch')?.addEventListener('input', e => { filters.q = e.target.value; subLimit = 50; filterRows(); });
  $('#statusFilter')?.addEventListener('change', e => { filters.status = e.target.value; subLimit = 50; filterRows(); });
  $('#addAccount')?.addEventListener('click', addAccount);
  $('#addWorker')?.addEventListener('click', addWorker);
  $('#addAnnouncement')?.addEventListener('click', addAnnouncement);
  $('#settingsForm')?.addEventListener('submit', saveSettings);
  $('#chatForm')?.addEventListener('submit', sendMessage);
  $('#subFrom')?.addEventListener('change', e => { filters.from = e.target.value; subLimit = 50; renderPage(); });
  $('#subTo')?.addEventListener('change', e => { filters.to = e.target.value; subLimit = 50; renderPage(); });
  $('#clearDates')?.addEventListener('click', () => { filters.from = ''; filters.to = ''; subLimit = 50; renderPage(); });
  $('#whatsNewBtn')?.addEventListener('click', () => showWhatsNew(true));
  $('#exportCsv')?.addEventListener('click', () => exportCsv());
  $('#repFrom')?.addEventListener('change', e => { reportFrom = e.target.value; renderPage(); });
  $('#repTo')?.addEventListener('change', e => { reportTo = e.target.value; renderPage(); });
  $('#repClear')?.addEventListener('click', () => { reportFrom = ''; reportTo = ''; renderPage(); });
  $('#exportFiltered')?.addEventListener('click', () => exportCsv(true));
  $('#printPayslip')?.addEventListener('click', () => printPayslip(''));
  $('#payslipMonth')?.addEventListener('change', e => { payslipMonth = e.target.value; renderPage(); });
  $('#moreAudit')?.addEventListener('click', () => { auditLimit += 50; startAudit(); });
  $('#missedFrom')?.addEventListener('change', e => { missedFrom = e.target.value; renderPage(); });
  $('#missedTo')?.addEventListener('change', e => { missedTo = e.target.value; renderPage(); });
  $('#auditSearch')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $$('#pageContent tbody tr').forEach(r => r.classList.toggle('hidden', !r.textContent.toLowerCase().includes(q)));
  });
  $('#workerSearch')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $$('#pageContent tbody tr').forEach(r => r.classList.toggle('hidden', !r.textContent.toLowerCase().includes(q)));
  });
  $('#peerSearch')?.addEventListener('input', e => { peerSearch = e.target.value; updatePeerList(); });
  $('#watchSearch')?.addEventListener('input', e => { watchSearch = e.target.value; updateWatchList(); });
  $('#watchWindow')?.addEventListener('submit', e => { if (e.target.id === 'watchForm') { e.preventDefault(); sendWatch(e.target.elements.message); } });
  $('#peerWindow')?.addEventListener('submit', e => { if (e.target.id === 'peerForm') { e.preventDefault(); sendPeer(e.target.elements.message); } });
  const pm = $('#peerMessages');
  if (pm) pm.scrollTop = pm.scrollHeight;
  const cm = $('#chatMessages');
  if (cm) cm.scrollTop = cm.scrollHeight;
  const lc = $('#liveChat');
  if (lc) lc.scrollTop = lc.scrollHeight;
}

function filterRows() {
  const rows = filteredSubmissions();
  const body = $('#submissionRows');
  if (body) body.innerHTML = submissionRowsPaged(rows);
  const c = $('#recordCount');
  if (c) c.textContent = rows.length + ' record(s)';
}

/* ───────────────────────── Submissions ───────────────────────── */
function viewSubmission(id, scroll = true) {
  const s = visibleSubmissions().find(x => x.id === id);
  if (!s) return;
  detailId = id;
  const processed = num(s.receiptCount), errs = num(s.errorCount);
  const errRate = processed > 0 ? (errs / processed * 100).toFixed(1) + '%' : '0%';
  const actions = (isAdmin() ? `<button class="btn btn-secondary" id="editCountsBtn">Edit counts</button>` : '') +
    (isAdmin() && s.status !== 'rejected' ? `<button class="btn btn-ghost" id="allowResubmitBtn">Allow resubmit</button>` : '') +
    (isAdmin() && s.status === 'pending' ? `<button class="btn btn-primary" id="approveOne">Approve</button><button class="btn btn-danger" id="rejectOne">Reject</button>` : '');
  const reason = s.rejectionReason ? `<div class="notice warn">Rejection reason: ${esc(s.rejectionReason)}</div>` : '';
  const errNote = s.errorNote ? `<div class="notice">Error note: ${esc(s.errorNote)}</div>` : '';
  const lateNote = num(s.lateErrors) > 0 ? `<div class="notice">+${num(s.lateErrors).toLocaleString()} late error(s) were added after this shift ended (they appeared later in Abukai).</div>` : '';
  const editedNote = s.editedByName ? `<div class="notice">Counts edited by ${esc(s.editedByName)}${s.editedAt ? ' on ' + esc(date(s.editedAt)) + ' ' + esc(fmtTime(s.editedAt)) : ''}.</div>` : '';
  const stats = s.startStats && s.endStats ? `<div class="notice">Abukai stats (pasted by the worker) · start: ${num(s.startStats.submitted).toLocaleString()} submitted / ${num(s.startStats.errors).toLocaleString()} errors → end: ${num(s.endStats.submitted).toLocaleString()} submitted / ${num(s.endStats.errors).toLocaleString()} errors.</div>` : '';
  const html = `<div class="panel"><div class="panel-head"><div><h3>Submission details</h3><p>${esc(s.id)}</p></div><button class="btn btn-ghost" id="closeDetails">Close</button></div><div class="form-grid"><div><p class="muted">Worker</p><b>${esc(s.workerName)}</b></div><div><p class="muted">Status</p>${status(s.status)}</div><div><p class="muted">Account</p><b>${esc(s.accountName)}</b></div><div><p class="muted">Shift date</p><b>${esc(date(s.shiftDate))}</b></div><div><p class="muted">Shift hours</p><b>${esc(s.startTime)} – ${esc(s.endTime)}</b></div><div><p class="muted">Processed receipts</p><b>${processed.toLocaleString()}</b></div><div><p class="muted">Error count</p><b${errs > 0 ? ' style="color:#c0392b"' : ''}>${errs.toLocaleString()}</b></div><div><p class="muted">Error rate</p><b>${errRate}</b></div><div><p class="muted">Gross pay</p><b>${money(s.grossCents)}</b></div><div><p class="muted">Deductions</p><b>${money(s.deductionCents)}</b></div><div><p class="muted">Net pay</p><b>${money(s.netCents)}</b></div></div>${stats}${errNote}${lateNote}${reason}${editedNote}<div class="right" style="justify-content:flex-end;margin-top:20px;gap:8px">${actions}</div></div>`;
  $('#detailsPanel')?.remove();
  $('#pageContent').insertAdjacentHTML('afterbegin', `<div id="detailsPanel">${html}</div>`);
  $('#closeDetails').onclick = () => { detailId = null; $('#detailsPanel')?.remove(); };
  $('#editCountsBtn')?.addEventListener('click', () => editCounts(s.id));
  $('#allowResubmitBtn')?.addEventListener('click', () => allowResubmit(s.id));
  $('#approveOne')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    if (!await confirmBox('Approve submission?', `Are you sure you want to approve ${s.workerName || 'this worker'}'s shift?`, 'Yes, approve')) return;
    btn.disabled = true;
    try { await reviewSubmission(s, 'approved'); } catch { btn.disabled = false; }
  });
  $('#rejectOne')?.addEventListener('click', () => {
    openModal('Reject submission',
      `<div class="field"><label>REASON FOR REJECTION</label><textarea name="reason" required maxlength="500" placeholder="Tell the worker what to correct…"></textarea></div>`,
      async fd => {
        const r = String(fd.get('reason') || '').trim();
        if (!r) { toast('A reason is required.'); return false; }
        if (!await confirmBox('Reject submission?', 'Are you sure you want to reject this shift submission?', 'Yes, reject', true)) return false;
        await reviewSubmission(s, 'rejected', r);
      }, 'Reject');
  });
  if (scroll) $('#detailsPanel').scrollIntoView({ behavior: 'smooth' });
}

async function reviewSubmission(stale, statusValue, reason = '') {
  if (!isAdmin()) return;
  // Always use the freshest copy from the live snapshot, not the object captured when the panel opened.
  const s = data.submissions.find(x => x.id === stale.id) || stale;
  if (s.status !== 'pending') {
    toast('This submission was already reviewed.');
    detailId = null;
    $('#detailsPanel')?.remove();
    return;
  }
  if (!configured) {
    s.status = statusValue; s.rejectionReason = reason;
    detailId = null;
    logAudit(statusValue === 'approved' ? 'Approved submission' : 'Rejected submission', `${s.workerName || 'Worker'} · ${s.accountName || ''} · ${s.shiftDate}${reason ? ' · reason: ' + reason : ''}`);
    toast('Demo record updated only.');
    renderPage();
    return;
  }
  try {
    await fb.updateDoc(fb.doc(db, 'submissions', s.id), {
      status: statusValue, rejectionReason: reason,
      reviewedBy: currentUser.uid, reviewedAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp()
    });
    if (statusValue === 'rejected') await patchAccountLast(s.id, s.accountId, { open: false }); // rejected shifts get no more late errors
    detailId = null;
    logAudit(statusValue === 'approved' ? 'Approved submission' : 'Rejected submission', `${s.workerName || 'Worker'} · ${s.accountName || ''} · ${s.shiftDate}${reason ? ' · reason: ' + reason : ''}`);
    toast('Submission ' + statusValue + '.');
    $('#detailsPanel')?.remove();
  } catch (e) {
    console.error(e);
    toast('Could not update submission. Check Firestore rules.');
    throw e;
  }
}

/* ADMIN: edit processed / error counts and recalculate pay */
async function editCounts(id) {
  if (!isAdmin()) return;
  const s = data.submissions.find(x => x.id === id);
  if (!s) return toast('Submission not found.');
  if (s.status === 'approved' && !await confirmBox('Edit approved shift?', 'This shift is already approved. Editing will change the worker\'s net pay. Continue?', 'Yes, continue')) return;

  openModal('Edit receipt counts',
    `<p class="muted" style="margin-top:0"><b>${esc(s.workerName || 'Worker')}</b> · ${esc(s.accountName || '')} · ${esc(date(s.shiftDate))} · ${esc(s.shiftType || '')}</p>
     <div class="field"><label>PROCESSED RECEIPTS (INCLUDING ERRORS)</label><input name="receiptCount" type="number" min="0" step="1" value="${num(s.receiptCount)}" required></div>
     <div class="field"><label>ERROR COUNT (PART OF PROCESSED)</label><input name="errorCount" type="number" min="0" step="1" value="${num(s.errorCount)}" required></div>
     <div class="field"><label>ERROR NOTE (OPTIONAL)</label><input name="errorNote" maxlength="200" value="${esc(s.errorNote || '')}" placeholder="e.g. Blurry images, wrong amounts"></div>
     <div class="notice">Pay is recalculated from the processed count using the rate saved on this submission.</div>`,
    async fd => {
      const processed = parseInt(fd.get('receiptCount'), 10);
      const errs = parseInt(fd.get('errorCount'), 10);
      if (!Number.isFinite(processed) || processed < 0) { toast('Enter a valid processed count.'); return false; }
      if (!Number.isFinite(errs) || errs < 0) { toast('Enter a valid error count.'); return false; }
      if (!await confirmBox('Save changes?', 'Are you sure you want to update the processed and error counts for this shift?', 'Yes, save changes')) return false;

      // Use the rate/deduction that applied to this submission, not today's settings.
      const oldCount = num(s.receiptCount), oldGross = num(s.grossCents);
      const rateCents = s.rateCents != null ? num(s.rateCents) : (oldCount > 0 ? oldGross / oldCount : rate());
      const pct = s.deductionPercent != null ? num(s.deductionPercent) : (oldGross > 0 ? num(s.deductionCents) / oldGross * 100 : dedPct());
      const gross = Math.round(processed * rateCents);
      const ded = Math.round(gross * pct / 100);

      const changes = {
        receiptCount: processed, errorCount: errs,
        errorNote: String(fd.get('errorNote') || '').trim(),
        rateCents, deductionPercent: pct,
        grossCents: gross, deductionCents: ded, netCents: gross - ded
      };

      const auditMsg = `${s.workerName || 'Worker'} · ${s.accountName || ''} · ${s.shiftDate} — processed ${oldCount}→${processed}, errors ${num(s.errorCount)}→${errs}`;
      if (!configured) {
        logAudit('Edited counts', auditMsg);
        Object.assign(s, changes, { updatedAt: new Date(), editedByName: profile.displayName });
        toast('Demo counts updated (not saved online).');
        renderPage();
        return;
      }
      await fb.updateDoc(fb.doc(db, 'submissions', s.id), {
        ...changes, editedBy: currentUser.uid, editedByName: profile.displayName, editedAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp()
      });
      await patchAccountLast(s.id, s.accountId, { receipts: processed, errors: errs }); // keep the late-errors cap in step
      logAudit('Edited counts', auditMsg);
      clearTimeout(lbTimer); clearTimeout(statsTimer);
      await Promise.allSettled([syncLeaderboard(), syncAccountStats()]); // refresh every stored total right now instead of waiting for the timer
      toast('Counts updated · pay and all totals recalculated.');
    }, 'Save changes');
}

/* ───────────────────────── Accounts ───────────────────────── */
function addAccount() {
  openModal('Add account',
    `<div class="field"><label>ACCOUNT NAME</label><input name="name" required maxlength="80" placeholder="e.g. Abukai Team Alpha"></div>
     <div class="field"><label>ACCOUNT CODE</label><input name="code" maxlength="20" placeholder="e.g. ABK-01"></div>
     <div class="field"><label>NOTES (OPTIONAL)</label><input name="notes" maxlength="200"></div>`,
    async fd => {
      const name = String(fd.get('name') || '').trim();
      const code = String(fd.get('code') || '').trim();
      if (!name) return false;
      if (code && data.accounts.some(a => (a.code || '').toLowerCase() === code.toLowerCase())) { toast('That account code already exists.'); return false; }
      const item = { name, code, notes: String(fd.get('notes') || '').trim(), assignedWorkerIds: [], assignedWorkerNames: [], isActive: true };
      if (!configured) {
        data.accounts.push({ ...item, id: 'local-' + Date.now(), createdAt: new Date(), updatedAt: new Date() });
        toast('Demo account added.');
        renderPage();
        return;
      }
      await fb.addDoc(fb.collection(db, 'accounts'), { ...item, createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp() });
      logAudit('Created account', `${name}${code ? ' (' + code + ')' : ''}`);
      toast('Account created.');
    }, 'Create account');
}

/* ADMIN: edit account name / code / notes (e.g. fix spelling) */
function editAccount(id) {
  if (!isAdmin()) return;
  const a = data.accounts.find(x => x.id === id);
  if (!a) return toast('Account not found.');
  const oldName = a.name;
  openModal('Edit account',
    `<div class="field"><label>ACCOUNT NAME</label><input name="name" required maxlength="80" value="${esc(a.name || '')}"></div>
     <div class="field"><label>ACCOUNT CODE</label><input name="code" maxlength="20" value="${esc(a.code || '')}"></div>
     <div class="field"><label>NOTES (OPTIONAL)</label><input name="notes" maxlength="200" value="${esc(a.notes || '')}"></div>
     <div class="notice">The new name will also be updated on this account's past submissions.</div>`,
    async fd => {
      const name = String(fd.get('name') || '').trim();
      const code = String(fd.get('code') || '').trim();
      const notes = String(fd.get('notes') || '').trim();
      if (!name) { toast('Account name is required.'); return false; }
      if (code && data.accounts.some(x => x.id !== a.id && (x.code || '').toLowerCase() === code.toLowerCase())) { toast('That account code already exists.'); return false; }
      if (!await confirmBox('Save changes?', `Are you sure you want to update the account "${oldName}"?`, 'Yes, save changes')) return false;

      if (!configured) {
        Object.assign(a, { name, code, notes, updatedAt: new Date() });
        data.submissions.forEach(s => { if (s.accountId === a.id) s.accountName = name; });
        toast('Demo account updated.');
        renderPage();
        return;
      }
      await fb.updateDoc(fb.doc(db, 'accounts', a.id), { name, code, notes, updatedAt: fb.serverTimestamp() });
      logAudit('Edited account', name !== oldName ? `${oldName} → ${name}` : name);
      if (name !== oldName) {
        try {
          const ops = data.submissions.filter(s => s.accountId === a.id).map(s => b => b.update(fb.doc(db, 'submissions', s.id), { accountName: name }));
          await commitInChunks(ops);
        } catch (e) { console.warn(e); toast('Account updated, but old submissions kept the previous name (check Firestore rules).'); return; }
      }
      toast('Account updated.');
    }, 'Save changes');
}

/* ADMIN: delete an account (past submissions are kept) */
async function deleteAccount(id) {
  if (!isAdmin()) return;
  const a = data.accounts.find(x => x.id === id);
  if (!a) return toast('Account not found.');
  if (!await confirmBox('Delete account?', `Are you sure you want to delete "${a.name}"? Workers will lose access to it. Past submissions are kept. This cannot be undone.`, 'Yes, delete', true)) return;

  if (!configured) {
    data.accounts = data.accounts.filter(x => x.id !== id);
    data.users.forEach(u => { u.assignedAccountIds = (u.assignedAccountIds || []).filter(x => x !== id); });
    toast('Demo account deleted.');
    renderPage();
    return;
  }
  try {
    const ops = [b => b.delete(fb.doc(db, 'accounts', id))];
    data.users.filter(u => (u.assignedAccountIds || []).includes(id)).forEach(u => {
      ops.push(b => b.update(fb.doc(db, 'users', u.id), { assignedAccountIds: fb.arrayRemove(id), updatedAt: fb.serverTimestamp() }));
    });
    if (activeShiftOf(id)) ops.push(b => b.delete(fb.doc(db, 'activeShifts', id))); // free any running shift on this account
    await commitInChunks(ops);
    try { await fb.deleteDoc(fb.doc(db, 'accountLast', id)); } catch {} // best effort: no more late errors for a deleted account
    logAudit('Deleted account', a.name);
    toast('Account deleted.');
  } catch (e) { console.error(e); toast('Could not delete account. Check Firestore rules.'); }
}

async function toggleAccount(id) {
  const a = data.accounts.find(x => x.id === id);
  if (!a || !isAdmin()) return;
  const next = a.isActive === false;
  const ok = next
    ? await confirmBox('Activate account?', `Are you sure you want to activate "${a.name}"?`, 'Yes, activate')
    : await confirmBox('Deactivate account?', `Are you sure you want to deactivate "${a.name}"? Workers will no longer be able to submit shifts for it.`, 'Yes, deactivate', true);
  if (!ok) return;
  if (!configured) { a.isActive = next; renderPage(); return; }
  try {
    await fb.updateDoc(fb.doc(db, 'accounts', id), { isActive: next, updatedAt: fb.serverTimestamp() });
    logAudit(next ? 'Activated account' : 'Deactivated account', a.name);
    toast(next ? 'Account activated.' : 'Account deactivated.');
  } catch (e) { console.error(e); toast('Could not update account. Check Firestore rules.'); }
}

function assignWorker(accountId) {
  const account = data.accounts.find(a => a.id === accountId);
  if (!account) return toast('Account not found.');
  const eligible = data.users.filter(u => u.role === 'worker' && u.isActive !== false && (u.status || 'approved') === 'approved');
  if (!eligible.length) return toast('No approved workers found.');
  const current = new Set(account.assignedWorkerIds || []);

  const body = `<p class="muted" style="margin-top:0">Select the workers who can submit shifts for <b>${esc(account.name)}</b>.</p>` +
    eligible.map(w => `<label class="sh-check"><input type="checkbox" name="w" value="${esc(w.id)}" ${current.has(w.id) ? 'checked' : ''}><span><b>${esc(w.displayName || w.email || w.id)}</b><br><small class="muted">${esc(w.email || '')}</small></span></label>`).join('');

  openModal('Assign workers', body, async fd => {
    const picked = fd.getAll('w');
    const keep = [...current].filter(id => !eligible.some(w => w.id === id)); // e.g. deactivated workers stay assigned
    const ids = [...new Set([...picked, ...keep])];
    const nameOf = id => { const u = data.users.find(x => x.id === id); return u?.displayName || u?.email || 'Worker'; };
    const names = ids.map(nameOf);

    if (!await confirmBox('Save assignments?', `Are you sure you want to update the worker assignments for "${account.name}"?`, 'Yes, save')) return false;

    if (!configured) {
      account.assignedWorkerIds = ids; account.assignedWorkerNames = names;
      eligible.forEach(w => {
        const list = new Set(w.assignedAccountIds || []);
        if (ids.includes(w.id)) list.add(account.id); else list.delete(account.id);
        w.assignedAccountIds = [...list];
      });
      toast('Demo assignment updated.');
      renderPage();
      return;
    }
    const batch = fb.writeBatch(db);
    batch.update(fb.doc(db, 'accounts', account.id), { assignedWorkerIds: ids, assignedWorkerNames: names, updatedAt: fb.serverTimestamp() });
    eligible.forEach(w => {
      const was = current.has(w.id), now = ids.includes(w.id);
      if (was === now) return;
      batch.update(fb.doc(db, 'users', w.id), { assignedAccountIds: now ? fb.arrayUnion(account.id) : fb.arrayRemove(account.id), updatedAt: fb.serverTimestamp() });
    });
    await batch.commit();
    logAudit('Assigned workers', `${account.name}: ${names.join(', ') || 'none'}`);
    toast('Assignments saved.');
  }, 'Save assignments');
}

/* ───────────────────────── Workers ───────────────────────── */
function viewWorker(id) {
  const u = data.users.find(x => x.id === id);
  if (!u) return;
  const accts = (u.assignedAccountIds || []).map(aid => data.accounts.find(a => a.id === aid)?.name || aid);
  openModal('Worker profile', `<div class="form-grid" style="grid-template-columns:1fr">
    <div><p class="muted">Name</p><b>${esc(u.displayName || 'Unnamed')}</b></div>
    <div><p class="muted">Email</p><b>${esc(u.email || '—')}</b></div>
    <div><p class="muted">Role / status</p><b>${esc(u.role || 'worker')} · ${esc(u.status || 'approved')} · ${u.isActive === false ? 'inactive' : 'active'}</b></div>
    <div><p class="muted">Assigned accounts</p><b>${esc(accts.join(', ') || 'None')}</b></div>
    <div><p class="muted">Agreement</p><b>${esc(agreementLabel(u))}${u.agreement?.signedName ? ' · signed as ' + esc(u.agreement.signedName) : ''}</b></div></div>`, null);
}

/* ADMIN: edit a worker's name (e.g. fix spelling). Login email cannot be changed from the browser for another user. */
function editWorker(u) {
  if (!isAdmin()) return;
  const oldName = u.displayName || '';
  openModal('Edit worker',
    `<div class="field"><label>FULL NAME</label><input name="name" required maxlength="80" value="${esc(oldName)}"></div>
     <div class="field"><label>EMAIL (LOGIN)</label><input value="${esc(u.email || '')}" disabled></div>
     <div class="notice">The new name will also be updated on this worker's past submissions and account assignments.</div>`,
    async fd => {
      const name = String(fd.get('name') || '').trim();
      if (!name) { toast('Name is required.'); return false; }
      if (!await confirmBox('Save changes?', `Are you sure you want to update this worker's name to "${name}"?`, 'Yes, save changes')) return false;

      if (!configured) {
        u.displayName = name;
        data.submissions.forEach(s => { if (s.workerId === u.id) s.workerName = name; });
        data.accounts.forEach(a => {
          const i = (a.assignedWorkerIds || []).indexOf(u.id);
          if (i >= 0) { a.assignedWorkerNames = [...(a.assignedWorkerNames || [])]; a.assignedWorkerNames[i] = name; }
        });
        toast('Demo worker updated.');
        renderPage();
        return;
      }
      await fb.updateDoc(fb.doc(db, 'users', u.id), { displayName: name, updatedAt: fb.serverTimestamp() });
      logAudit('Edited worker', name !== oldName ? `${oldName} → ${name}` : name);
      if (name !== oldName) {
        try {
          const ops = [];
          data.submissions.filter(s => s.workerId === u.id).forEach(s => ops.push(b => b.update(fb.doc(db, 'submissions', s.id), { workerName: name })));
          data.accounts.forEach(a => {
            const i = (a.assignedWorkerIds || []).indexOf(u.id);
            if (i < 0) return;
            const names = [...(a.assignedWorkerNames || [])];
            names[i] = name;
            ops.push(b => b.update(fb.doc(db, 'accounts', a.id), { assignedWorkerNames: names, updatedAt: fb.serverTimestamp() }));
          });
          await commitInChunks(ops);
        } catch (e) { console.warn(e); toast('Worker updated, but older records kept the previous name (check Firestore rules).'); return; }
      }
      toast('Worker updated.');
    }, 'Save changes');
}

/* ADMIN: set a worker's shift schedule. The worker can only submit output/errors inside this time window. */
function editSchedule(u) {
  if (!isAdmin()) return;
  const cur = u.shiftSchedule || {};
  const curType = cur.type || 'none';
  const radios = SHIFT_OPTIONS.map(o => `<label class="sh-check"><input type="radio" name="shift" value="${o.id}" ${curType === o.id ? 'checked' : ''}><span><b>${esc(o.label)}</b></span></label>`).join('');
  openModal('Shift schedule',
    `<p class="muted" style="margin-top:0">Choose the shift for <b>${esc(u.displayName || u.email)}</b>. The worker can only submit total output and errors during this time.</p>
     ${radios}
     <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:12px">
       <div class="field"><label>CUSTOM FROM</label><input type="time" name="from" value="${esc(cur.type === 'custom' ? (cur.from || '') : '')}"></div>
       <div class="field"><label>CUSTOM TO</label><input type="time" name="to" value="${esc(cur.type === 'custom' ? (cur.to || '') : '')}"></div>
     </div>
     <div class="notice">Custom time is only used when "Custom time" is selected.</div>`,
    async fd => {
      const type = String(fd.get('shift') || '');
      if (!type) { toast('Pick a shift first.'); return false; }
      let schedule = null;
      if (type === 'custom') {
        const from = String(fd.get('from') || ''), to = String(fd.get('to') || '');
        if (!from || !to) { toast('Enter both the From and To time.'); return false; }
        if (from === to) { toast('From and To cannot be the same.'); return false; }
        schedule = { type, from, to, label: `${fmt12(from)} – ${fmt12(to)}` };
      } else if (type !== 'none') {
        const o = SHIFT_OPTIONS.find(x => x.id === type);
        schedule = { type, from: o.from, to: o.to, label: o.label };
      }
      if (schedule) {
        const same = cur.type === type && (type !== 'custom' || (cur.from === schedule.from && cur.to === schedule.to));
        schedule.since = same && cur.since ? cur.since : todayStr();
      }
      if (!await confirmBox('Save shift schedule?', `Are you sure you want to set ${u.displayName || u.email}'s shift to "${schedule ? schedule.label : 'No schedule'}"?`, 'Yes, save')) return false;
      if (!configured) {
        u.shiftSchedule = schedule;
        toast('Demo schedule updated.');
        renderPage();
        return;
      }
      await fb.updateDoc(fb.doc(db, 'users', u.id), { shiftSchedule: schedule, updatedAt: fb.serverTimestamp() });
      logAudit('Changed shift schedule', `${u.displayName || u.email}: ${schedule ? schedule.label : 'No schedule'}`);
      toast('Shift schedule saved.');
    }, 'Save schedule');
}

/* CREATE WORKER — admin creates a login + profile without being signed out */
function addWorker() {
  if (!isAdmin()) return;
  openModal('Create worker',
    `<div class="field"><label>FULL NAME</label><input name="name" required maxlength="80" placeholder="e.g. Juan Dela Cruz"></div>
     <div class="field"><label>EMAIL</label><input name="email" type="email" required placeholder="worker@company.com"></div>
     <div class="field"><label>TEMPORARY PASSWORD</label><input name="password" type="password" required minlength="6" autocomplete="new-password" placeholder="At least 6 characters"></div>`,
    async fd => {
      const name = String(fd.get('name') || '').trim();
      const email = String(fd.get('email') || '').trim().toLowerCase();
      const password = String(fd.get('password') || '');
      if (!name || !email || password.length < 6) { toast('Fill in all fields (password min 6 characters).'); return false; }
      if (liveUsers().some(u => (u.email || '').toLowerCase() === email)) { toast('A worker with that email already exists.'); return false; }

      const profileDoc = { displayName: name, email, role: 'worker', status: 'approved', isActive: true, assignedAccountIds: [] };

      if (!configured) {
        data.users.push({ ...profileDoc, id: 'local-' + Date.now() });
        toast('Demo worker added (not saved online).');
        renderPage();
        return;
      }

      // A second Firebase app is used so the admin stays signed in on the main app.
      const secondary = fb.initializeApp(firebaseConfig, 'worker-creator-' + Date.now());
      const secAuth = fb.getAuth(secondary);
      try {
        const cred = await fb.createUserWithEmailAndPassword(secAuth, email, password);
        await fb.setDoc(fb.doc(db, 'users', cred.user.uid), {
          ...profileDoc, createdBy: currentUser.uid,
          createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp()
        });
        logAudit('Created worker', `${name} · ${email}`);
        toast('Worker created.');
      } catch (err) {
        console.error(err);
        toast(err.code === 'auth/email-already-in-use' ? 'That email still has a login. If this worker was deleted, the login clears the next time that person opens the app and signs in (or remove it in Firebase Console → Authentication).'
          : err.code === 'auth/weak-password' ? 'Password is too weak.'
          : err.code === 'auth/invalid-email' ? 'Please enter a valid email address.'
          : 'Could not create worker. Check Firestore rules.');
        return false;
      } finally {
        try { await fb.signOut(secAuth); } catch {}
        try { await fb.deleteApp(secondary); } catch {}
      }
    }, 'Create worker');
}

/* DELETE WORKER — removes the profile + account assignments (Auth login itself can only be removed from the Firebase console / Admin SDK) */
async function deleteWorker(u) {
  if (!isAdmin()) return;
  if (u.id === currentUser.uid) return toast('You cannot delete yourself.');
  if (!await confirmBox('Delete worker?', `Are you sure you want to delete ${u.displayName || u.email}? Their profile and login email will be removed (the email is cleared the next time they try to sign in) and they lose access. Past submissions are kept. This cannot be undone.`, 'Yes, delete', true)) return;

  if (!configured) {
    data.users = data.users.filter(x => x.id !== u.id);
    data.accounts.forEach(a => {
      a.assignedWorkerIds = (a.assignedWorkerIds || []).filter(id => id !== u.id);
    });
    data.activeShifts = data.activeShifts.filter(s => s.workerId !== u.id);
    toast('Demo worker deleted.');
    renderPage();
    return;
  }
  try {
    // The profile is kept as a hidden "deleted" marker. When that person next tries to sign in, the app deletes their login (email) itself.
    const ops = [b => b.update(fb.doc(db, 'users', u.id), { status: 'deleted', isActive: false, assignedAccountIds: [], shiftSchedule: null, deletedAt: fb.serverTimestamp(), deletedBy: currentUser.uid, updatedAt: fb.serverTimestamp() })];
    data.accounts.filter(a => (a.assignedWorkerIds || []).includes(u.id)).forEach(a => {
      const idx = (a.assignedWorkerIds || []).indexOf(u.id);
      ops.push(b => b.update(fb.doc(db, 'accounts', a.id), {
        assignedWorkerIds: (a.assignedWorkerIds || []).filter(id => id !== u.id),
        assignedWorkerNames: (a.assignedWorkerNames || []).filter((_, k) => k !== idx),
        updatedAt: fb.serverTimestamp()
      }));
    });
    // Free any account this worker was still working on.
    data.activeShifts.filter(s => s.workerId === u.id).forEach(s => ops.push(b => b.delete(fb.doc(db, 'activeShifts', s.id))));
    // Remove their ranking totals so they no longer appear in team rankings.
    data.leaderboard.filter(d => d.workerId === u.id).forEach(d => ops.push(b => b.delete(fb.doc(db, 'leaderboard', d.id))));
    await commitInChunks(ops);
    try { await fb.deleteDoc(fb.doc(db, 'presence', u.id)); } catch {} // best effort: stop showing them as online
    logAudit('Deleted worker', `${u.displayName || ''} · ${u.email || ''}`);
    toast('Worker deleted. Their login email is cleared the next time they try to sign in.');
  } catch (e) { console.error(e); toast('Could not delete worker. Check Firestore rules.'); }
}

async function workerAction(id, action) {
  if (!isAdmin()) return;
  const u = data.users.find(x => x.id === id);
  if (!u) return;
  if (action === 'delete') return deleteWorker(u);
  if (action === 'edit') return editWorker(u);
  if (action === 'schedule') return editSchedule(u);
  const changes = ({
    approve: { status: 'approved', isActive: true },
    reject: { status: 'rejected', isActive: false },
    activate: { isActive: true },
    deactivate: { isActive: false }
  })[action];
  if (!changes) return;
  const who = u.displayName || u.email;
  const labels = { approve: 'Approve', reject: 'Reject', activate: 'Activate', deactivate: 'Deactivate' };
  const danger = ['reject', 'deactivate'].includes(action);
  if (!await confirmBox(`${labels[action]} worker?`, `Are you sure you want to ${action} ${who}?`, `Yes, ${action}`, danger)) return;
  if (!configured) { Object.assign(u, changes); renderPage(); return; }
  try {
    await fb.updateDoc(fb.doc(db, 'users', id), { ...changes, updatedAt: fb.serverTimestamp() });
    logAudit(`${labels[action]} worker`, who);
    toast('Worker updated.');
  } catch (e) { console.error(e); toast('Could not update worker. Check Firestore rules.'); }
}

/* ───────────────────────── Settings, chat, export ───────────────────────── */
async function saveSettings(e) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  const rateVal = Number(f.get('rate')), deduction = Number(f.get('deduction')), errPct = Number(f.get('errWarn')), workLink = String(f.get('workUrl') || '').trim();
  if (!Number.isFinite(rateVal) || rateVal < 0) return toast('Enter a valid rate.');
  if (!Number.isFinite(deduction) || deduction < 0 || deduction > 100) return toast('Deduction must be between 0 and 100.');
  if (!Number.isFinite(errPct) || errPct < 0 || errPct > 100) return toast('Error warning must be between 0 and 100.');
  if (workLink && !/^https?:\/\//i.test(workLink)) return toast('The work link must start with https://');
  if (!await confirmBox('Save pay settings?', 'Are you sure you want to change the rate and deduction for future submissions?', 'Yes, save settings')) return;
  const gross = Math.round(rateVal * 100);
  if (!configured) {
    data.settings = { grossRateCents: gross, deductionPercent: deduction, errorWarnPercent: errPct, workUrl: workLink };
    toast('Demo settings updated only.');
    renderPage();
    return;
  }
  try {
    await fb.setDoc(fb.doc(db, 'settings', 'paySettings'), {
      id: 'paySettings', grossRateCents: gross, deductionPercent: deduction, errorWarnPercent: errPct, workUrl: workLink,
      updatedBy: currentUser.uid, updatedAt: fb.serverTimestamp()
    }, { merge: true });
    logAudit('Changed pay settings', `rate ₱${rateVal.toFixed(2)}, deduction ${deduction}%, error warning ${errPct}%`);
    toast('Pay settings saved.');
  } catch (err) { console.error(err); toast('Could not save settings. Check Firestore rules.'); }
}

async function sendMessage(e) {
  e.preventDefault();
  const input = e.currentTarget.elements.message;
  const text = input.value.trim();
  if (!text) return;
  const item = { senderId: currentUser.uid, senderName: profile.displayName, text };
  if (chatConv === 'dm') return sendDm(item, input);
  if (!configured) {
    data.messages.push({ ...item, id: 'm' + Date.now(), createdAt: new Date() });
    input.value = '';
    updateChat();
    return;
  }
  input.value = '';
  try {
    await fb.addDoc(fb.collection(db, 'conversations', 'company_group', 'messages'), { ...item, createdAt: fb.serverTimestamp() });
  } catch (err) {
    console.error(err);
    input.value = text; // restore so nothing is lost
    toast('Could not send message. Check Firestore rules.');
  }
}

function exportCsv(filtered = false) {
  const list = filtered === true ? filteredSubmissions() : visibleSubmissions().filter(inReportRange);
  if (!list.length) return toast('No records to export.');
  const rows = list.slice().sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt));
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const peso = c => (num(c) / 100).toFixed(2);
  const head = ['Worker', 'Account', 'Shift date', 'Shift', 'Start', 'End', 'Processed', 'Errors', 'Error note', 'Status', 'Gross (PHP)', 'Deductions (PHP)', 'Net (PHP)'];
  const lines = rows.map(r => [r.workerName, r.accountName, r.shiftDate, r.shiftType, r.startTime, r.endTime, r.receiptCount, num(r.errorCount), r.errorNote || '', r.status, peso(r.grossCents), peso(r.deductionCents), peso(r.netCents)].map(cell).join(','));
  const csv = '\ufeff' + [head.map(cell).join(','), ...lines].join('\r\n'); // BOM so Excel reads UTF-8
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `steivy-receipt-${filtered === true ? 'submissions' : 'report'}-${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ───────────────────────── What's new ─────────────────────────
   Shown once per user per device after each update. To announce a new release: change WHATS_NEW_VERSION and
   edit the WHATS_NEW list. Workers see items with who: 'all' or 'worker'; admins see 'all' or 'admin'.
   The "What's new" link in the sidebar reopens it any time. */
const WHATS_NEW_VERSION = '2026-11-d';
const WHATS_NEW = [
  { who: 'all', t: 'Mobile bottom navigation', d: 'Home, Shifts, Chat, Reports and More are one tap away on your phone, with a live unread badge on Chat.' },
  { who: 'all', t: 'Cleaner look', d: 'New icons, loading placeholders, friendlier empty pages and a refreshed sign-in screen.' },
  { who: 'all', t: 'Date range filter', d: 'In Submissions, pick a From and To date to see only the shifts you need.' },
  { who: 'all', t: 'Offline notice', d: 'A bar appears at the top when your internet drops, and disappears once you are back online.' },
  { who: 'all', t: 'Date range in Reports', d: 'Pick From and To dates to see earnings, export CSV and print payslips for just that period.' },
  { who: 'worker', t: 'Print your payslip', d: 'In Reports, choose a month and tap Print payslip. You can also save it as a PDF.' },
  { who: 'admin', t: 'Print payslips per worker', d: 'In Reports → By worker, tap Print payslip beside a worker. Pick the month first to limit the period.' }
];
const whatsNewKey = () => `steivy_whatsnew_${currentUser?.uid || 'anon'}`;
function maybeShowWhatsNew() {
  if (!currentUser || !profile || window.__wnTimer) return;
  let seen = '';
  try { seen = localStorage.getItem(whatsNewKey()) || ''; } catch { if (window.__wnSeen === WHATS_NEW_VERSION) return; }
  if (seen === WHATS_NEW_VERSION) return;
  let tries = 0;
  const attempt = () => {
    window.__wnTimer = null;
    if (!currentUser || !profile || $('#whatsNew')) return;
    // wait (up to ~1 minute) while another dialog is on screen, then show; never stack dialogs
    const busy = Array.from(document.querySelectorAll('.sh-modal')).some(m => m.getClientRects().length);
    if (busy && ++tries < 20) { window.__wnTimer = setTimeout(attempt, 3000); return; }
    if (!busy) showWhatsNew(false);
  };
  window.__wnTimer = setTimeout(attempt, 900);
}
function showWhatsNew(manual) {
  $('#whatsNew')?.remove();
  const mine = WHATS_NEW.filter(i => i.who === 'all' || i.who === (isAdmin() ? 'admin' : 'worker'));
  const wrap = document.createElement('div');
  wrap.className = 'sh-modal';
  wrap.id = 'whatsNew';
  wrap.innerHTML = `<div class="sh-modal-card whats-new" role="dialog" aria-modal="true" aria-labelledby="wnTitle"><h3 id="wnTitle">What’s new</h3><ul>${mine.map(i => `<li><b>${esc(i.t)}</b><span>${esc(i.d)}</span></li>`).join('')}</ul><div class="sh-modal-actions"><button type="button" class="btn btn-primary" data-wn-ok>Got it</button></div></div>`;
  document.body.appendChild(wrap);
  const onKey = e => { if (e.key === 'Escape') done(); };
  const done = () => {
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    try { localStorage.setItem(whatsNewKey(), WHATS_NEW_VERSION); } catch { window.__wnSeen = WHATS_NEW_VERSION; }
  };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) done(); });
  wrap.querySelector('[data-wn-ok]').addEventListener('click', done);
  wrap.querySelector('[data-wn-ok]').focus();
}

/* ───────────────────────── Print payslip ─────────────────────────
   Builds a clean A4 payslip (approved shifts only) in a hidden #printArea and calls window.print().
   styles.css has a @media print rule that hides the whole app and shows only #printArea.
   Workers print their own; admins print one worker at a time from Reports > By worker. */
let payslipMonth = '', reportFrom = '', reportTo = '';
const inReportRange = s => (!reportFrom || String(s.shiftDate || '') >= reportFrom) && (!reportTo || (s.shiftDate && String(s.shiftDate) <= reportTo));
function payslipMonthSelect(approved) {
  const ms = [...new Set(approved.map(s => monthOf(s)).filter(Boolean))].sort().reverse();
  if (payslipMonth && !ms.includes(payslipMonth)) payslipMonth = '';
  return `<select id="payslipMonth" aria-label="Payslip period"><option value="">All approved shifts</option>${ms.map(m => `<option value="${esc(m)}"${m === payslipMonth ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}</select>`;
}
function printPayslip(key) {
  const admin = isAdmin();
  let rows = visibleSubmissions().filter(s => s.status === 'approved' && inReportRange(s));
  if (admin) rows = rows.filter(s => (s.workerId || s.workerName || 'unknown') === key);
  if (payslipMonth) rows = rows.filter(s => monthOf(s) === payslipMonth);
  if (!rows.length) return toast('No approved shifts to print for this period.');
  rows = rows.slice().sort((a, b) => String(a.shiftDate || '').localeCompare(String(b.shiftDate || '')));
  const name = admin ? (rows[0].workerName || 'Worker') : (profile?.displayName || rows[0].workerName || 'Worker');
  const range = reportFrom || reportTo ? `${reportFrom ? date(reportFrom) : 'Start'} to ${reportTo ? date(reportTo) : date(todayStr())}` : '';
  const period = [payslipMonth ? monthLabel(payslipMonth) : '', range].filter(Boolean).join(' · ') || 'All approved shifts';
  const sum = f => rows.reduce((n, s) => n + num(s[f]), 0);
  const body = rows.map(s => `<tr><td>${esc(date(s.shiftDate))}</td><td>${esc(s.accountName || '—')}</td><td>${esc(s.shiftType || '—')}</td><td class="r">${num(s.receiptCount).toLocaleString()}</td><td class="r">${num(s.errorCount).toLocaleString()}</td><td class="r">${money(s.grossCents)}</td><td class="r">${money(s.deductionCents)}</td><td class="r">${money(s.netCents)}</td></tr>`).join('');
  $('#printArea')?.remove();
  const box = document.createElement('div');
  box.id = 'printArea';
  box.innerHTML = `<div class="ps-head"><img src="assets/logo.jpg" alt=""><div><b>STEIVY RECEIPT HUB</b><span>Payslip</span></div></div>
    <div class="ps-meta"><div><small>Worker</small><b>${esc(name)}</b></div><div><small>Period</small><b>${esc(period)}</b></div><div><small>Generated</small><b>${esc(date(todayStr()))}</b></div></div>
    <table><thead><tr><th>Shift date</th><th>Account</th><th>Shift</th><th class="r">Processed</th><th class="r">Errors</th><th class="r">Gross</th><th class="r">Deductions</th><th class="r">Net</th></tr></thead><tbody>${body}</tbody>
    <tfoot><tr><td colspan="3">Total (${rows.length} shift${rows.length === 1 ? '' : 's'})</td><td class="r">${sum('receiptCount').toLocaleString()}</td><td class="r">${sum('errorCount').toLocaleString()}</td><td class="r">${money(sum('grossCents'))}</td><td class="r">${money(sum('deductionCents'))}</td><td class="r">${money(sum('netCents'))}</td></tr></tfoot></table>
    <div class="ps-net"><span>Net payable</span><b>${money(sum('netCents'))}</b></div>
    <p class="ps-note">Includes approved submissions only. Rate per receipt ${money(rate())}, deduction ${dedPct()}% (current settings). This is a system-generated summary.</p>`;
  document.body.appendChild(box);
  const oldTitle = document.title;
  document.title = `Payslip - ${name} - ${period}`;
  const done = () => { document.title = oldTitle; box.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 80);
}

/* ───────────────────────── Co-worker private chat (same account only) ─────────────────────────
   Membership = accounts.assignedWorkerIds (the existing assignment system, no duplicate collection).
   Conversation id = <accountId>_<uidLow>_<uidHigh>. The Firestore rules parse that id and re-check the
   account assignment on the server, so hiding users in the UI is not the only protection.
   Collections: peerChats/{convId} (+ /messages/{id}). Listeners: one small list query per assigned account,
   plus one message listener for the conversation that is open. */
const demoPeerMsgs = {};
const pairId = (accountId, a, b) => `${accountId}_${[a, b].sort().join('_')}`;
const peerUnread = () => Object.values(peerConvs).reduce((n, c) => n + num(c.unread?.[currentUser?.uid]), 0);
const peerName = (id, fallback) => data.presence.find(p => p.id === id)?.displayName || fallback || 'Co-worker';
const peerOnline = id => isOnlineEntry(data.presence.find(p => p.id === id));
const peerTime = d => {
  const x = toDate(d);
  if (!x) return '';
  return x.toDateString() === new Date().toDateString() ? fmtTime(x) : date(x);
};

// Every other worker who shares at least one active account with me (one entry per shared account).
function peerContacts() {
  if (!currentUser) return [];
  const uid = currentUser.uid, out = [];
  data.accounts.forEach(a => {
    if (a.isActive === false) return;
    const ids = a.assignedWorkerIds || [];
    if (!ids.includes(uid)) return;
    ids.forEach((id, i) => {
      if (id === uid) return;
      out.push({ convId: pairId(a.id, uid, id), peerId: id, accountId: a.id, accountName: a.name || 'Account', name: peerName(id, a.assignedWorkerNames?.[i]) });
    });
  });
  return out;
}

function stopPeerMsgs() { if (peerMsgUnsub) { try { peerMsgUnsub(); } catch {} peerMsgUnsub = null; } }
function stopPeer() {
  Object.values(peerUnsubs).forEach(f => { try { f(); } catch {} });
  peerUnsubs = {}; peerReady = {}; peerConvs = {};
  stopPeerMsgs();
  peerMsgs = []; peerSel = null; peerSearch = '';
}

// One list listener per assigned account (cheap: only my conversations). Re-run whenever accounts change.
function syncPeerListeners() {
  if (!configured || !db || !currentUser || !profile || isAdmin()) return;
  const uid = currentUser.uid;
  const want = new Set(data.accounts.filter(a => a.isActive !== false && (a.assignedWorkerIds || []).includes(uid)).map(a => a.id));
  Object.keys(peerUnsubs).forEach(id => {
    if (want.has(id)) return;
    try { peerUnsubs[id](); } catch {}
    delete peerUnsubs[id]; delete peerReady[id];
    Object.keys(peerConvs).forEach(k => { if (peerConvs[k].accountId === id) delete peerConvs[k]; });
  });
  // No longer assigned to the account of the open conversation: close it.
  if (peerSel && !peerContacts().some(c => c.convId === peerSel.convId)) { peerSel = null; stopPeerMsgs(); peerMsgs = []; }
  const { collection, onSnapshot, query, where } = fb;
  want.forEach(id => {
    if (peerUnsubs[id]) return;
    peerUnsubs[id] = onSnapshot(query(collection(db, 'peerChats'), where('accountId', '==', id), where('participants', 'array-contains', uid)), s => {
      if (peerReady[id]) {
        s.docChanges().forEach(ch => {
          if (ch.type === 'removed' || ch.doc.metadata.hasPendingWrites) return;
          const d = ch.doc.data();
          if (d.lastSenderId === uid) return;
          if (num(d.unread?.[uid]) <= num(peerConvs[ch.doc.id]?.unread?.[uid])) return; // nothing new for me
          if (page === 'coworkers' && peerSel?.convId === ch.doc.id && !document.hidden) return; // already reading it
          const c = peerContacts().find(x => x.convId === ch.doc.id);
          showChatPopup({ senderName: (d.participants || []).includes(d.lastSenderId) ? peerName(d.lastSenderId, c?.name) : 'Admin', text: d.lastMessage, peer: true, convId: ch.doc.id });
        });
      }
      peerReady[id] = true;
      Object.keys(peerConvs).forEach(k => { if (peerConvs[k].accountId === id) delete peerConvs[k]; });
      s.docs.forEach(d => { peerConvs[d.id] = { id: d.id, ...d.data() }; });
      if (page === 'coworkers') updatePeerList();
      updatePeerBadge();
      markPeerRead();
    }, err => console.warn('peerChats listener (check Firestore rules for /peerChats)', err));
  });
}

function startPeerMsgs() {
  stopPeerMsgs();
  if (!configured || !db || !peerSel) return;
  const id = peerSel.convId;
  const { collection, onSnapshot, query, orderBy, limit } = fb;
  peerMsgUnsub = onSnapshot(query(collection(db, 'peerChats', id, 'messages'), orderBy('createdAt', 'desc'), limit(CHAT_LIMIT)), s => {
    if (peerSel?.convId !== id) return;
    peerMsgs = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => timeVal(a.createdAt) - timeVal(b.createdAt));
    updatePeerMessages();
    markPeerRead();
  }, err => { console.warn('peer messages (check Firestore rules for /peerChats)', err); toast('Could not load this conversation. Check Firestore rules.'); });
}

// Marks messages I received as read and clears my unread counter (only while the conversation is on screen).
function markPeerRead() {
  if (!configured || !db || page !== 'coworkers' || document.hidden || !peerSel || !currentUser) return;
  const uid = currentUser.uid, id = peerSel.convId;
  const unread = peerMsgs.filter(m => m.receiverId === uid && m.isRead !== true && !m.id.startsWith('local'));
  const conv = peerConvs[id];
  const needConv = !!conv && num(conv.unread?.[uid]) > 0;
  if (!unread.length && !needConv) return;
  unread.forEach(m => { m.isRead = true; }); // local flag: avoids repeating while the write is in flight
  if (needConv) conv.unread = { ...conv.unread, [uid]: 0 };
  updatePeerBadge();
  const ops = unread.slice(0, 400).map(m => b => b.update(fb.doc(db, 'peerChats', id, 'messages', m.id), { isRead: true, readAt: fb.serverTimestamp() }));
  if (needConv) ops.push(b => b.update(fb.doc(db, 'peerChats', id), { [`unread.${uid}`]: 0 }));
  commitInChunks(ops).catch(e => console.warn('peer read receipt failed (check Firestore rules)', e));
}

async function sendPeer(input) {
  const text = input.value.trim();
  const c = peerSel;
  if (!text || !c || !currentUser) return;
  if (!peerContacts().some(x => x.convId === c.convId)) return toast('You are no longer assigned to this account.');
  const uid = currentUser.uid;
  if (!configured) {
    const m = { id: 'local' + Date.now(), senderId: uid, receiverId: c.peerId, message: text, createdAt: new Date(), isRead: false };
    (demoPeerMsgs[c.convId] ||= []).push(m);
    peerMsgs = demoPeerMsgs[c.convId];
    peerConvs[c.convId] = { ...(peerConvs[c.convId] || {}), accountId: c.accountId, lastMessage: text, lastMessageAt: new Date(), lastSenderId: uid, unread: {} };
    input.value = '';
    updatePeerMessages(); updatePeerList();
    return;
  }
  input.value = '';
  try {
    const [lo, hi] = [uid, c.peerId].sort();
    const b = fb.writeBatch(db);
    b.set(fb.doc(fb.collection(db, 'peerChats', c.convId, 'messages')), {
      accountId: c.accountId, conversationId: c.convId, senderId: uid, receiverId: c.peerId,
      message: text, createdAt: fb.serverTimestamp(), isRead: false, readAt: null
    });
    b.set(fb.doc(db, 'peerChats', c.convId), {
      accountId: c.accountId, participants: [lo, hi],
      lastMessage: text.slice(0, 200), lastMessageAt: fb.serverTimestamp(), lastSenderId: uid, updatedAt: fb.serverTimestamp(),
      unread: { [c.peerId]: fb.increment(1) }
    }, { merge: true });
    await b.commit();
  } catch (err) {
    console.error(err);
    input.value = text; // restore so nothing is lost
    toast('Could not send message. Check Firestore rules and your account assignment.');
  }
}

function openPeer(convId) {
  const c = peerContacts().find(x => x.convId === convId);
  if (!c) return;
  if (peerSel?.convId !== convId) {
    peerSel = c;
    stopPeerMsgs();
    peerMsgs = configured ? [] : (demoPeerMsgs[convId] || []);
  }
  if (configured && !peerMsgUnsub) startPeerMsgs();
  const w = $('#peerWindow');
  if (!w) return renderPage();
  w.innerHTML = peerWindowHtml();
  updatePeerList();
  const box = $('#peerMessages');
  if (box) box.scrollTop = box.scrollHeight;
  w.querySelector('input[name=message]')?.focus();
  markPeerRead();
}

/* ── rendering (partial updates only, so typing and search text are never wiped) ── */
function peerListHtml() {
  const uid = currentUser.uid, q = peerSearch.trim().toLowerCase();
  const at = c => { const v = peerConvs[c.convId]?.lastMessageAt; return v ? timeVal(v) : 0; };
  const all = peerContacts();
  const list = all.filter(c => !q || `${c.name} ${c.accountName}`.toLowerCase().includes(q))
    .sort((a, b) => a.accountName.localeCompare(b.accountName) || at(b) - at(a) || a.name.localeCompare(b.name));
  if (!list.length) return `<div class="empty"><span class="empty-ico">${EMPTY_ICONS.workers}</span><b>${all.length ? 'No match' : 'No co-workers yet'}</b>${all.length ? 'Try another name.' : 'You can chat with workers who are assigned to the same account as you.'}</div>`;
  let lastAcct = '';
  return list.map(c => {
    const head = c.accountId !== lastAcct ? `<div style="padding:10px 14px 4px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.7">${esc(c.accountName)}</div>` : '';
    lastAcct = c.accountId;
    const conv = peerConvs[c.convId];
    const unread = num(conv?.unread?.[uid]);
    const prev = conv?.lastMessage ? (conv.lastSenderId === uid ? 'You: ' : (conv.participants || []).includes(conv.lastSenderId) ? '' : 'Admin: ') + conv.lastMessage : 'No messages yet';
    return `${head}<button type="button" class="${peerSel?.convId === c.convId ? 'active' : ''}" data-peer="${esc(c.convId)}"><div class="avatar peer-av">${esc(initials(c.name))}<i class="peer-dot ${peerOnline(c.peerId) ? 'on' : ''}"></i></div><div class="peer-meta"><strong>${esc(c.name)}</strong><small>${esc(prev)}</small></div><div class="peer-side"><small>${esc(peerTime(conv?.lastMessageAt))}</small>${unread ? `<span class="nav-badge">${unread > 9 ? '9+' : unread}</span>` : ''}</div></button>`;
  }).join('');
}
const peerStatusHtml = () => peerSel ? `<span class="peer-st-dot ${peerOnline(peerSel.peerId) ? 'on' : ''}"></span>${peerOnline(peerSel.peerId) ? 'Online' : 'Offline'}` : '';
function peerBubbles() {
  if (!peerMsgs.length) return '<div class="empty"><span class="empty-ico">${EMPTY_ICONS.chat}</span><b>No messages yet</b>Say hello to start the conversation.</div>';
  let lastDay = '';
  return peerMsgs.map(m => {
    const mine = m.senderId === currentUser.uid;
    const x = toDate(m.createdAt) || new Date();
    const day = x.toDateString();
    const sep = day !== lastDay ? `<div class="peer-day">${esc(date(x))}</div>` : '';
    lastDay = day;
    const tick = mine ? `<span class="peer-tick" title="${m.isRead ? 'Read' : 'Sent'}">${m.isRead ? '✓✓' : '✓'}</span>` : '';
    return `${sep}<div class="bubble ${mine ? 'mine' : ''}">${m.fromAdmin ? '<b style="display:block;font-size:11px;color:#d9a400;margin-bottom:2px">🛡 Admin</b>' : ''}${esc(m.message || '')}<small>${esc(fmtTime(m.createdAt))}${tick}</small></div>`;
  }).join('');
}
function peerWindowHtml() {
  if (!peerSel) return `<div class="chat-messages" id="peerMessages"><div class="empty"><span class="empty-ico">${EMPTY_ICONS.chat}</span><b>Select a co-worker</b>Pick someone on the left to start a private chat.</div></div>`;
  return `<div class="peer-head"><div class="avatar">${esc(initials(peerSel.name))}</div><div><strong>${esc(peerSel.name)}</strong><small id="peerStatus">${peerStatusHtml()}</small></div><small>Account: ${esc(peerSel.accountName)}</small></div><div class="chat-messages" id="peerMessages">${peerBubbles()}</div><form class="chat-compose" id="peerForm"><input name="message" placeholder="Message ${esc(peerSel.name)}…" maxlength="2000" autocomplete="off" required><button class="btn btn-primary" type="submit">Send ↗</button></form>`;
}
function updatePeerBadge() {
  const n = peerUnread();
  $$('[data-nav="coworkers"]').forEach(b => {
    b.querySelector('.nav-badge')?.remove();
    if (n > 0) b.insertAdjacentHTML('beforeend', `<span class="nav-badge">${n > 9 ? '9+' : n}</span>`);
  });
}
function updatePeerList() {
  const el = $('#peerItems');
  if (!el) return;
  el.innerHTML = peerListHtml();
  const st = $('#peerStatus');
  if (st && peerSel) st.innerHTML = peerStatusHtml();
  updatePeerBadge();
}
function updatePeerMessages() {
  const box = $('#peerMessages');
  if (!box || !peerSel) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const lastMine = peerMsgs.slice(-1)[0]?.senderId === currentUser?.uid;
  box.innerHTML = peerBubbles();
  if (nearBottom || lastMine) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  updatePeerList();
}
/* ───────────────── Team totals per account (Co-worker page) ───────────────── */
const statsId = (m, acct, w) => `${m}_${acct}_${w}`;
const demoStat = (acct, w, m) => data.submissions.filter(s => s.accountId === acct && s.workerId === w && (s.status === 'approved' || s.status === 'pending') && monthOf(s) === m)
  .reduce((t, s) => ({ receipts: t.receipts + num(s.receiptCount), errors: t.errors + num(s.errorCount), shifts: t.shifts + 1 }), { receipts: 0, errors: 0, shifts: 0 });

// ADMIN: keeps /accountStats in sync (approved + pending shifts, rejected left out). Writes only the documents whose numbers changed.
function scheduleStatsSync() { clearTimeout(statsTimer); statsTimer = setTimeout(syncAccountStats, 2000); }
async function syncAccountStats() {
  if (!configured || !db || !currentUser || !isAdmin() || !loaded.accountStats || !loaded.submissions || !loaded.users) return;
  const validIds = new Set(liveUsers().filter(u => u.role !== 'admin').map(u => u.id));
  const winStart = subWindowMonth();
  const want = new Map();
  data.submissions.forEach(s => {
    if (!s.accountId || !s.workerId || !validIds.has(s.workerId) || (s.status !== 'approved' && s.status !== 'pending')) return;
    const m = monthOf(s);
    if (!/^\d{4}-\d{2}$/.test(m) || m < winStart) return;
    const id = statsId(m, s.accountId, s.workerId);
    const g = want.get(id) || { accountId: s.accountId, accountName: data.accounts.find(a => a.id === s.accountId)?.name || s.accountName || 'Account', workerId: s.workerId, workerName: s.workerName || 'Worker', month: m, receipts: 0, errors: 0, shifts: 0 };
    g.receipts += num(s.receiptCount); g.errors += num(s.errorCount); g.shifts += 1;
    want.set(id, g);
  });
  data.accountStats.forEach(d => { // stored, but no submissions back it any more (edited, rejected, deleted): reset to zero
    if (want.has(d.id) || String(d.month || '') < winStart) return;
    if (num(d.receipts) || num(d.errors) || num(d.shifts)) want.set(d.id, { accountId: d.accountId, accountName: d.accountName || 'Account', workerId: d.workerId, workerName: d.workerName || 'Worker', month: d.month, receipts: 0, errors: 0, shifts: 0 });
  });
  const old = new Map(data.accountStats.map(d => [d.id, d]));
  const writes = [...want].filter(([id, g]) => {
    const o = old.get(id);
    return !o || num(o.receipts) !== g.receipts || num(o.errors) !== g.errors || num(o.shifts) !== g.shifts || (o.workerName || '') !== g.workerName || (o.accountName || '') !== g.accountName;
  });
  if (!writes.length) return;
  try {
    await commitInChunks(writes.map(([id, g]) => b => b.set(fb.doc(db, 'accountStats', id), { ...g, updatedAt: fb.serverTimestamp() }, { merge: true })));
  } catch (e) { console.warn('accountStats write failed (publish the latest firestore.rules)', e); }
}

// WORKER: one small query per assigned account (this month only), started only while the Co-workers page is open.
function startStatsListen() {
  if (!configured || !db || !currentUser || isAdmin()) return;
  const { collection, onSnapshot, query, where } = fb;
  const uid = currentUser.uid, month = monthKeyOf(0);
  if (statsMonth && statsMonth !== month) { stopStatsListen(); data.accountStats = []; }
  statsMonth = month;
  const want = new Set(data.accounts.filter(a => a.isActive !== false && (a.assignedWorkerIds || []).includes(uid)).map(a => a.id));
  Object.keys(statsDocs).forEach(id => {
    if (want.has(id)) return;
    try { statsDocs[id](); } catch {}
    delete statsDocs[id];
    data.accountStats = data.accountStats.filter(x => x.accountId !== id);
  });
  want.forEach(id => {
    if (statsDocs[id]) return;
    statsDocs[id] = onSnapshot(query(collection(db, 'accountStats'), where('accountId', '==', id), where('month', '==', month)), s => {
      statsErr = false;
      data.accountStats = data.accountStats.filter(x => x.accountId !== id).concat(s.docs.map(d => ({ id: d.id, ...d.data() })));
      updateTeamStats();
    }, err => {
      console.warn('accountStats listener (publish the latest firestore.rules)', err);
      statsErr = true;
      updateTeamStats();
    });
  });
}
function stopStatsListen() { Object.values(statsDocs).forEach(f => { try { f(); } catch {} }); statsDocs = {}; statsMonth = ''; }

function teamStatsHtml() {
  if (!currentUser || isAdmin()) return '';
  const uid = currentUser.uid, month = monthKeyOf(0);
  const accts = data.accounts.filter(a => a.isActive !== false && (a.assignedWorkerIds || []).includes(uid)).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (!accts.length) return '';
  const warn = statsErr ? `<div class="empty"><span class="empty-ico">${EMPTY_ICONS.errors}</span><b>Team totals are not available yet</b>Ask the admin to publish the latest Firestore rules.</div>` : '';
  const panels = accts.map(a => {
    const rows = (a.assignedWorkerIds || []).map((id, i) => {
      const st = (configured ? data.accountStats.find(x => x.id === statsId(month, a.id, id)) : demoStat(a.id, id, month)) || {};
      const name = id === uid ? 'You' : (st.workerName || a.assignedWorkerNames?.[i] || peerName(id));
      return { id, name, receipts: num(st.receipts), errors: num(st.errors), shifts: num(st.shifts) };
    }).sort((x, y) => (y.id === uid) - (x.id === uid) || y.receipts - x.receipts || x.name.localeCompare(y.name));
    const tot = rows.reduce((t, r) => ({ receipts: t.receipts + r.receipts, errors: t.errors + r.errors }), { receipts: 0, errors: 0 });
    const pct = (r, e) => errRatePct(r, e).toFixed(1) + '%';
    const body = rows.map(r => `<tr><td><strong>${esc(r.name)}</strong></td><td>${r.receipts.toLocaleString()}</td><td>${r.errors.toLocaleString()}</td><td>${pct(r.receipts, r.errors)}</td></tr>`).join('');
    return `<div class="panel" style="margin-bottom:12px"><div class="panel-head"><div><h3>${esc(a.name || 'Account')}</h3><p>${esc(monthLabel(month))} · total output and errors per co-worker · approved + pending shifts</p></div></div><div class="table-wrap"><table><thead><tr><th>Co-worker</th><th>Total output</th><th>Errors</th><th>Error rate</th></tr></thead><tbody>${body}<tr><td><strong>Account total</strong></td><td><strong>${tot.receipts.toLocaleString()}</strong></td><td><strong>${tot.errors.toLocaleString()}</strong></td><td><strong>${pct(tot.receipts, tot.errors)}</strong></td></tr></tbody></table></div></div>`;
  }).join('');
  return warn + panels;
}
function updateTeamStats() { const el = $('#teamStats'); if (el) el.innerHTML = teamStatsHtml(); }

/* ───────────────── Admin: read-only monitor of co-worker chats ───────────────── */
const userNameOf = id => { const u = data.users.find(x => x.id === id); return u?.displayName || u?.email || 'Worker'; };
const watchInfo = c => ({ account: data.accounts.find(a => a.id === c.accountId)?.name || 'Account', a: userNameOf((c.participants || [])[0]), b: userNameOf((c.participants || [])[1]) });
const watchSeenKey = () => 'watchSeen:' + (currentUser?.uid || '');
function loadWatchSeen() { try { watchSeen = JSON.parse(localStorage.getItem(watchSeenKey()) || 'null'); } catch { watchSeen = null; } }
function saveWatchSeen() { try { localStorage.setItem(watchSeenKey(), JSON.stringify(watchSeen || {})); } catch {} }
const convMs = c => (c && c.lastMessageAt ? timeVal(c.lastMessageAt) : 0) || 0;
const watchIsNew = c => !!c && c.lastSenderId !== currentUser?.uid && convMs(c) > num((watchSeen || {})[c.id]); // a worker wrote after I last read it
const watchUnread = () => watchConvs.filter(watchIsNew).length;
function updateWatchBadge() {
  const n = watchUnread();
  $$('[data-nav="peerwatch"]').forEach(b => {
    b.querySelector('.nav-badge')?.remove();
    if (n > 0) b.insertAdjacentHTML('beforeend', `<span class="nav-badge">${n > 9 ? '9+' : n}</span>`);
  });
}
function markWatchSeen(id) {
  const c = watchConvs.find(x => x.id === id);
  if (!c) return;
  watchSeen = watchSeen || {};
  const ms = convMs(c) || Date.now();
  if (num(watchSeen[id]) >= ms) return;
  watchSeen[id] = ms; saveWatchSeen();
  updateWatchBadge(); updateWatchList();
}
function startWatch() {
  if (watchUnsub || !configured || !db || !isAdmin()) return;
  loadWatchSeen();
  const { collection, onSnapshot, query, orderBy, limit } = fb;
  watchUnsub = onSnapshot(query(collection(db, 'peerChats'), orderBy('lastMessageAt', 'desc'), limit(60)), s => {
    const next = s.docs.map(d => ({ id: d.id, ...d.data() }));
    if (watchSeen === null) { watchSeen = {}; next.forEach(c => { watchSeen[c.id] = convMs(c); }); saveWatchSeen(); } // first run: existing chats count as read
    const reading = id => page === 'peerwatch' && watchSel === id && !document.hidden;
    if (watchReady) s.docChanges().forEach(ch => {
      if (ch.type === 'removed' || ch.doc.metadata.hasPendingWrites) return;
      const d = { id: ch.doc.id, ...ch.doc.data() };
      if (d.lastSenderId === currentUser?.uid || reading(d.id)) return; // my own reply, or I am reading it right now
      showChatPopup({ senderName: userNameOf(d.lastSenderId), text: d.lastMessage, peer: true, watch: true, convId: d.id });
    });
    watchReady = true;
    watchConvs = next;
    updateWatchBadge(); updateWatchList();
    if (watchSel && reading(watchSel)) markWatchSeen(watchSel);
  }, err => { console.warn('peerChats monitor (publish the latest firestore.rules)', err); toast('Could not load co-worker chats. Publish the latest Firestore rules.'); });
}function stopWatchMsgs() { if (watchMsgUnsub) { try { watchMsgUnsub(); } catch {} watchMsgUnsub = null; } }
function stopWatch() { if (watchUnsub) { try { watchUnsub(); } catch {} watchUnsub = null; } stopWatchMsgs(); watchConvs = []; watchSel = null; watchMsgs = []; watchReady = false; watchSeen = null; }
function openWatch(id) {
  const c = watchFind(id);
  if (!c || !configured || !db) return;
  if (watchSel !== id) {
    watchSel = id; stopWatchMsgs(); watchMsgs = [];
    const i = watchInfo(c);
    if (!c.virtual) logAudit('Viewed co-worker chat', `${i.a} ↔ ${i.b} · ${i.account}`); // every look is on record
    const { collection, onSnapshot, query, orderBy, limit } = fb;
    watchMsgUnsub = onSnapshot(query(collection(db, 'peerChats', id, 'messages'), orderBy('createdAt', 'desc'), limit(50)), s => {
      if (watchSel !== id) return;
      watchMsgs = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => timeVal(x.createdAt) - timeVal(y.createdAt));
      updateWatchWindow();
      if (page === 'peerwatch' && !document.hidden) markWatchSeen(id); // I am looking at it
    }, err => { console.warn('peerChats messages (publish the latest firestore.rules)', err); toast('Could not load this conversation. Publish the latest Firestore rules.'); });
  }
  markWatchSeen(id);
  updateWatchList(); updateWatchWindow();
}
// ADMIN: reply inside a co-worker conversation. The message carries fromAdmin:true (workers cannot forge it: the rules only accept it from an admin)
// and bumps both workers' unread counters, so they get the usual badge and popup.
async function sendWatch(input) {
  const text = input.value.trim();
  const c = watchFind(watchSel);
  if (!text || !c || !configured || !db || !currentUser || !isAdmin()) return;
  const [p1, p2] = c.participants || [];
  if (!p1 || !p2) return;
  const uid = currentUser.uid, i = watchInfo(c);
  input.value = '';
  try {
    const b = fb.writeBatch(db);
    b.set(fb.doc(fb.collection(db, 'peerChats', c.id, 'messages')), {
      accountId: c.accountId, conversationId: c.id, senderId: uid, senderName: profile.displayName || 'Admin', receiverId: 'both',
      message: text, createdAt: fb.serverTimestamp(), isRead: false, readAt: null, fromAdmin: true
    });
    if (c.virtual) { // first message of this pair: the admin creates the conversation (the rules check both workers are assigned to the account)
      b.set(fb.doc(db, 'peerChats', c.id), {
        accountId: c.accountId, participants: [p1, p2], lastMessage: text.slice(0, 200), lastMessageAt: fb.serverTimestamp(), lastSenderId: uid, updatedAt: fb.serverTimestamp(),
        unread: { [p1]: 1, [p2]: 1 }
      });
    } else {
      b.update(fb.doc(db, 'peerChats', c.id), {
        lastMessage: text.slice(0, 200), lastMessageAt: fb.serverTimestamp(), lastSenderId: uid, updatedAt: fb.serverTimestamp(),
        [`unread.${p1}`]: fb.increment(1), [`unread.${p2}`]: fb.increment(1)
      });
    }
    await b.commit();
    logAudit('Replied in co-worker chat', `${i.a} ↔ ${i.b} · ${i.account}`);
  } catch (err) {
    console.error(err);
    input.value = text; // restore so nothing is lost
    toast('Could not send. Publish the latest Firestore rules.');
  }
}
// Every pair of workers who share an account, merged with the chats that already exist, so the admin sees ALL of them (also pairs who never wrote yet).
function allWatch() {
  const real = new Set(watchConvs.map(c => c.id));
  const out = [...watchConvs];
  data.accounts.forEach(a => {
    if (a.isActive === false) return;
    const ids = (a.assignedWorkerIds || []).filter(id => { const u = data.users.find(x => x.id === id); return u && u.role !== 'admin' && u.isActive !== false && (u.status || 'approved') === 'approved'; });
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const [lo, hi] = [ids[i], ids[j]].sort();
      const id = pairId(a.id, lo, hi);
      if (!real.has(id)) out.push({ id, accountId: a.id, participants: [lo, hi], virtual: true });
    }
  });
  return out;
}
const watchFind = id => allWatch().find(c => c.id === id);

// Output / errors of an account this month (approved + pending), from the submissions the admin already has: no extra reads, always current.
function acctMonthTotals() {
  const m = monthKeyOf(0), t = new Map();
  data.submissions.forEach(s => {
    if (!s.accountId || (s.status !== 'approved' && s.status !== 'pending') || monthOf(s) !== m) return;
    const g = t.get(s.accountId) || { receipts: 0, errors: 0 };
    g.receipts += num(s.receiptCount); g.errors += num(s.errorCount);
    t.set(s.accountId, g);
  });
  return t;
}
const watchTotHtml = g => `<span style="font-size:11px;font-weight:600;opacity:.85;white-space:nowrap">Output ${num(g?.receipts).toLocaleString()} · Errors ${num(g?.errors).toLocaleString()}</span>`;
function watchListHtml() {
  const q = watchSearch.trim().toLowerCase();
  const all = allWatch();
  const list = all.filter(c => { const i = watchInfo(c); return !q || `${i.account} ${i.a} ${i.b} ${c.lastMessage || ''}`.toLowerCase().includes(q); })
    .sort((x, y) => (!!x.virtual - !!y.virtual) || convMs(y) - convMs(x) || watchInfo(x).account.localeCompare(watchInfo(y).account) || watchInfo(x).a.localeCompare(watchInfo(y).a));
  if (!list.length) return `<div class="empty"><span class="empty-ico">${EMPTY_ICONS.chat}</span><b>${all.length ? 'No match' : 'No co-workers share an account yet'}</b>${all.length ? 'Try another name.' : 'Assign two or more workers to the same account to see them here.'}</div>`;
  const tot = acctMonthTotals();
  let sawVirtual = false;
  return list.map(c => {
    const i = watchInfo(c), fresh = watchIsNew(c);
    const head = c.virtual && !sawVirtual ? `<div style="padding:10px 14px 4px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.7">No messages yet</div>` : '';
    if (c.virtual) sawVirtual = true;
    return `${head}<button type="button" class="${watchSel === c.id ? 'active' : ''}" data-watch="${esc(c.id)}"><div class="avatar peer-av">${esc(initials(i.account))}</div><div class="peer-meta"><strong style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">${esc(i.account)}${watchTotHtml(tot.get(c.accountId))}</strong><small>${esc(i.a)} ↔ ${esc(i.b)}</small><small>${esc(c.lastMessage || 'No messages yet')}</small></div><div class="peer-side"><small>${esc(peerTime(c.lastMessageAt))}</small>${fresh ? '<span class="nav-badge">New</span>' : ''}</div></button>`;
  }).join('');
}
function watchBubbles() {
  const c = watchFind(watchSel);
  if (!c) return '';
  if (!watchMsgs.length) return '<div class="empty"><span class="empty-ico">${EMPTY_ICONS.chat}</span><b>No messages yet</b></div>';
  const first = (c.participants || [])[0];
  let lastDay = '';
  return watchMsgs.map(m => {
    const x = toDate(m.createdAt) || new Date(), day = x.toDateString();
    const sep = day !== lastDay ? `<div class="peer-day">${esc(date(x))}</div>` : '';
    lastDay = day;
    return `${sep}<div class="bubble ${m.senderId === first ? '' : 'mine'}"><b style="display:block;font-size:11px;opacity:.75;margin-bottom:2px">${esc(userNameOf(m.senderId))}${m.fromAdmin ? ' · 🛡 Admin' : ''}</b>${esc(m.message || '')}<small>${esc(fmtTime(m.createdAt))}</small></div>`;
  }).join('');
}
function watchWindowHtml() {
  const c = watchFind(watchSel);
  if (!c) return `<div class="chat-messages" id="watchMessages"><div class="empty"><span class="empty-ico">${EMPTY_ICONS.chat}</span><b>Select a conversation</b>Pick a chat on the left to read it and reply as Admin.</div></div>`;
  const i = watchInfo(c), g = acctMonthTotals().get(c.accountId);
  return `<div class="peer-head"><div class="avatar">${esc(initials(i.account))}</div><div><strong style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">${esc(i.account)}${watchTotHtml(g)}</strong><small>${esc(i.a)} ↔ ${esc(i.b)} · ${c.virtual ? 'no messages yet, your message starts the chat' : 'you can reply as Admin'}</small></div></div><div class="chat-messages" id="watchMessages">${watchBubbles()}</div><form class="chat-compose" id="watchForm"><input name="message" placeholder="Reply as Admin…" maxlength="2000" autocomplete="off" required><button class="btn btn-primary" type="submit">Send ↗</button></form>`;
}
function updateWatchList() { const el = $('#watchItems'); if (el) el.innerHTML = watchListHtml(); }
function updateWatchWindow() {
  const w = $('#watchWindow');
  if (!w) return;
  w.innerHTML = watchWindowHtml();
  const box = $('#watchMessages');
  if (box) box.scrollTop = box.scrollHeight;
}
function peerWatchPage() {
  if (!isAdmin()) return '';
  return `<div class="welcome"><div><h2>Co-worker chats</h2><p>Each chat is titled with its account and this month's total output and errors. Read the chats between workers on the same account and reply as Admin: your messages show to both workers with an Admin badge, and you get a badge and popup when a worker writes. Workers are told that admins may review these chats, and every conversation you open or reply in is recorded in the audit log.</p></div></div><div class="chat-layout peer-layout"><div class="chat-list" id="watchList"><div class="peer-search"><input id="watchSearch" placeholder="Search worker, account or message…" value="${esc(watchSearch)}" autocomplete="off"></div><div id="watchItems">${watchListHtml()}</div></div><div class="chat-window peer-window" id="watchWindow">${watchWindowHtml()}</div></div>`;
}

function coworkersPage() {
  if (isAdmin()) return `<div class="empty"><span class="empty-ico">${EMPTY_ICONS.workers}</span><b>Workers only</b>Co-worker chat is private between workers on the same account.</div>`;
  return `<div class="welcome"><div><h2>Co-worker chat</h2><p>One-on-one messages with workers assigned to the same account as you. Admins may review these chats for quality and safety.</p></div></div><div id="teamStats">${teamStatsHtml()}</div><div class="chat-layout peer-layout"><div class="chat-list" id="peerList"><div class="peer-search"><input id="peerSearch" placeholder="Search co-workers…" value="${esc(peerSearch)}" autocomplete="off"></div><div id="peerItems">${peerListHtml()}</div></div><div class="chat-window peer-window" id="peerWindow">${peerWindowHtml()}</div></div>`;
}

/* ───────────────────────── Boot ───────────────────────── */
async function boot() {
  const ok = await initFirebase();
  if (!ok) { renderLogin(); return; }

  fb.onAuthStateChanged(auth, async user => {
    const token = ++authToken;
    unlisten();
    closeModal();
    $('#shiftWarn')?.remove();
    $('#shiftRemind')?.remove();
    $('#confirmBox')?.remove();
    $('#chatPopups')?.remove();
    if (!user) {
      // Already signed out: only stop timers (a presence write would be rejected now).
      clearPresenceTimers();
      currentUser = null; profile = null;
      renderLogin();
      return;
    }

    try {
      const snap = await fb.getDoc(fb.doc(db, 'users', user.uid));
      if (token !== authToken) return;
      if (!snap.exists()) {
        toast('Your sign-in worked, but no approved user profile exists. Ask an administrator for access.');
        await fb.signOut(auth);
        return;
      }
      const p = { id: snap.id, ...snap.data() };
      p.displayName = p.displayName || user.displayName || user.email || 'User';
      if (p.status === 'deleted') {
        let removed = false;
        try { await fb.deleteUser(user); removed = true; } catch (e) { console.warn('could not delete login', e); }
        if (!removed) { try { await fb.signOut(auth); } catch {} }
        toast('Your account was deleted by the administrator.');
        return;
      }
      if (p.isActive === false || p.status === 'rejected' || p.status === 'pending') {
        toast(p.status === 'pending' ? 'Your account is awaiting approval.' : 'Your account is not active.');
        await fb.signOut(auth);
        return;
      }
      if (!['admin', 'worker'].includes(p.role)) {
        toast('Your account has no valid role. Contact an administrator.');
        await fb.signOut(auth);
        return;
      }
      currentUser = { uid: user.uid, email: user.email || '', displayName: p.displayName };
      profile = p;
      page = 'dashboard';
      detailId = null;
      await loadData();
      if (token !== authToken) return;
      startPresence();
      renderPage();
      showShiftWarning();
    } catch (e) {
      console.error(e);
      toast('Could not load your profile. Check Firestore rules.');
      renderLogin();
    }
  });
}

boot();
