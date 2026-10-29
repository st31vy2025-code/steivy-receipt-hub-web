// Steivy Receipt Hub — app.js
// Features: Create/Edit/Delete worker, Add/Edit/Delete account, "Are you sure?" confirmations,
// Team-chat popups + live chat feed, Top performers / Top errors leaderboards, Error Processed, Admin edit counts.
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
let lbPeriod = 'month', lbError = false, lbTimer = null;
let loaded = {};
const filters = { q: '', status: 'all' };
const DEFAULT_SETTINGS = { grossRateCents: 100, deductionPercent: 10 };
const data = { submissions: [], accounts: [], users: [], messages: [], presence: [], announcements: [], annRead: [], leaderboard: [], settings: { ...DEFAULT_SETTINGS } };

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

let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
function unlisten() { unsubs.forEach(fn => { try { fn(); } catch {} }); unsubs = []; }

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
.standing.info{background:#f1f8f4}`;
document.head.appendChild(extraStyle);

/* ───────────────────────── Presence (who is online) ───────────────────────── */
const ONLINE_WINDOW_MS = 150000; // a worker counts as online if seen in the last 2.5 minutes
let heartbeatTimer = null, onlineTimer = null;

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
  const el = $('#onlineStrip');
  if (!el) return;
  const key = onlineKey();
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = onlineInner();
}

async function beat(online = true) {
  if (!configured || !db || !currentUser || !profile) return;
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
  heartbeatTimer = setInterval(() => { if (!document.hidden) beat(true); }, 45000);
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
document.addEventListener('visibilitychange', () => { if (!document.hidden && heartbeatTimer) beat(true); });
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
  return `<div class="panel"><div class="panel-head"><div><h3>Announcements</h3><p>Posted notes pop up on every user's dashboard until they close them</p></div><button class="btn btn-primary" id="addAnnouncement">📢 Post announcement</button></div>${rows || '<div class="empty">📢<b>No active announcements</b>Post a note to show it to all users.</div>'}</div>`;
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
      toast('Announcement posted. It will pop up for all users.');
    }, 'Post to all users');
}

async function removeAnnouncement(id) {
  if (!isAdmin()) return;
  if (!await confirmBox('Remove announcement?', 'Are you sure you want to remove this announcement? It will disappear for everyone.', 'Yes, remove', true)) return;
  if (!configured) { data.announcements = data.announcements.filter(a => a.id !== id); renderPage(); return; }
  try {
    await fb.deleteDoc(fb.doc(db, 'announcements', id));
    toast('Announcement removed.');
  } catch (e) { console.error(e); toast('Could not remove announcement. Check Firestore rules.'); }
}

// Last month / this month processed receipts and errors for the dashboard (rejected excluded)
function monthStats(rows) {
  const cur = monthKeyOf(0), prev = monthKeyOf(-1);
  const sum = key => rows
    .filter(s => s.status !== 'rejected' && String(s.shiftDate || '').slice(0, 7) === key)
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
    const [appmod, authmod, fsmod] = await Promise.all([
      import(base + 'firebase-app.js'),
      import(base + 'firebase-auth.js'),
      import(base + 'firebase-firestore.js')
    ]);
    // initializeApp/deleteApp are kept so we can create (and clean up) a secondary app when an admin creates a worker.
    fb = { ...authmod, ...fsmod, initializeApp: appmod.initializeApp, deleteApp: appmod.deleteApp };
    const app = appmod.initializeApp(firebaseConfig);
    auth = authmod.getAuth(app);
    db = fsmod.getFirestore(app);
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
    if (page === 'dashboard') updateLiveFeed();
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

function listen(path, key, queryFn) {
  const { collection, onSnapshot, query, where, orderBy, limit } = fb;
  let ref = collection(db, path);
  if (queryFn) ref = queryFn(ref, { query, where, orderBy, limit });
  const stop = onSnapshot(ref, s => {
    data[key] = s.docs.map(d => ({ id: d.id, ...d.data() }));
    loaded[key] = true;
    if (key === 'submissions' || key === 'users') scheduleLbSync();
    requestRender();
  }, err => {
    console.error(path, err);
    toast('Could not load ' + path + '. Check Firestore rules.');
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
  data.messages = []; data.presence = []; data.leaderboard = [];
  data.settings = { ...DEFAULT_SETTINGS };
  loaded = {}; chatReady = false; unreadChat = 0; lbError = false;

  if (isAdmin()) {
    listen('accounts', 'accounts');
    listen('submissions', 'submissions');
    listen('users', 'users');
  } else {
    // Workers only query what they are allowed to read.
    listen('accounts', 'accounts', (ref, q) => q.query(ref, q.where('assignedWorkerIds', 'array-contains', uid)));
    listen('submissions', 'submissions', (ref, q) => q.query(ref, q.where('workerId', '==', uid)));
    data.users = [];
  }

  unsubs.push(onSnapshot(doc(db, 'settings', 'paySettings'), s => {
    data.settings = { ...DEFAULT_SETTINGS, ...(s.exists() ? s.data() : {}) };
    requestRender();
  }, () => {}));

  unsubs.push(onSnapshot(query(collection(db, 'announcements'), orderBy('createdAt', 'desc'), limit(30)), s => {
    data.announcements = s.docs.map(d => ({ id: d.id, ...d.data() }));
    requestRender();
  }, err => console.warn('announcements listener (check Firestore rules)', err)));
  unsubs.push(onSnapshot(doc(db, 'announcementReads', uid), s => {
    data.annRead = s.exists() ? (s.data().dismissedIds || []) : [];
    syncAnnouncementPopup();
  }, err => console.warn('announcementReads listener (check Firestore rules)', err)));

  unsubs.push(onSnapshot(collection(db, 'presence'), s => {
    presenceReadErr = false;
    data.presence = s.docs.map(d => ({ id: d.id, ...d.data() }));
    updateOnline();
  }, err => {
    console.warn('presence listener (check Firestore rules for /presence)', err);
    presenceReadErr = true;
    updateOnline();
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

  const msgQuery = query(collection(db, 'conversations', 'company_group', 'messages'), orderBy('createdAt', 'desc'), limit(150));
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
    if (s.status === 'rejected' || !s.workerId) return;
    if (!inPeriod(String(s.shiftDate || '').slice(0, 7), period)) return;
    add(s.workerId, s.workerName, num(s.receiptCount), num(s.errorCount), 1);
  });
  if (isAdmin() || !configured) {
    fromSubs(data.submissions);
    const valid = new Set(data.users.filter(u => u.role !== 'admin').map(u => u.id)); // deleted workers are not ranked
    return [...map.values()].filter(r => valid.has(r.id));
  }
  data.leaderboard.forEach(d => {
    if (d.workerId === currentUser.uid || !inPeriod(d.month, period)) return;
    add(d.workerId, d.workerName, num(d.receipts), num(d.errors), num(d.shifts));
  });
  fromSubs(data.submissions.filter(s => s.workerId === currentUser.uid)); // my own numbers always come from live data
  return [...map.values()];
}

function rankings(period) {
  const rows = boardRows(period).filter(r => r.receipts > 0 || r.errors > 0);
  const byOut = [...rows].sort((a, b) => b.receipts - a.receipts || a.errors - b.errors || a.name.localeCompare(b.name));
  const byErr = rows.filter(r => r.errors > 0).sort((a, b) => b.errors - a.errors || b.receipts - a.receipts || a.name.localeCompare(b.name));
  return { rows, byOut, byErr };
}

// Keeps /leaderboard in sync. Admin writes totals for every worker; a worker writes only their own.
function scheduleLbSync() { clearTimeout(lbTimer); lbTimer = setTimeout(syncLeaderboard, 1500); }
async function syncLeaderboard() {
  if (!configured || !db || !currentUser || !loaded.leaderboard || !loaded.submissions) return;
  if (isAdmin() && !loaded.users) return;
  const uid = currentUser.uid, admin = isAdmin();
  const validIds = admin ? new Set(data.users.filter(u => u.role !== 'admin').map(u => u.id)) : null;
  const mine = (admin ? data.submissions : data.submissions.filter(s => s.workerId === uid)).filter(s => s.workerId && (!admin || validIds.has(s.workerId)));
  const want = new Map();
  mine.forEach(s => {
    if (s.status === 'rejected') return;
    const m = String(s.shiftDate || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) return;
    const id = `${s.workerId}_${m}`;
    const g = want.get(id) || { workerId: s.workerId, workerName: s.workerName || 'Worker', month: m, receipts: 0, errors: 0, shifts: 0 };
    g.receipts += num(s.receiptCount); g.errors += num(s.errorCount); g.shifts += 1;
    want.set(id, g);
  });
  // Anything stored before that no longer has submissions (edited, rejected, deleted) is reset to zero.
  data.leaderboard.forEach(d => {
    if (!(admin ? validIds.has(d.workerId) : d.workerId === uid) || want.has(d.id)) return;
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

function top5Panel(title, sub, list, kind) {
  const val = r => kind === 'out' ? r.receipts : r.errors;
  const max = Math.max(1, ...list.slice(0, 5).map(val));
  const rows = list.slice(0, 5).map((r, i) => `<div class="lb-row"><span class="lb-rank">${medal(i)}</span><div class="avatar">${esc(initials(r.name))}</div><div class="lb-main"><div class="lb-top"><b>${esc(r.name)}</b><span class="lb-val ${kind === 'err' ? 'err' : ''}">${val(r).toLocaleString()} ${kind === 'out' ? 'receipts' : 'error(s)'}</span></div><div class="lb-bar"><div class="lb-fill ${kind === 'err' ? 'err' : ''}" style="width:${(val(r) / max * 100).toFixed(1)}%"></div></div><small class="muted">${kind === 'out' ? num(r.errors).toLocaleString() + ' error(s) · ' : num(r.receipts).toLocaleString() + ' processed · '}${r.shifts} shift(s)</small></div></div>`).join('');
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
  else if (er === 1) err = { cls: 'danger', icon: '⚠️', title: 'You have the MOST errors', text: `${me.errors.toLocaleString()} error(s) in ${label}, the highest in the team. Please double-check each receipt before submitting.` };
  else if (er === 2) err = { cls: 'danger', icon: '⚠️', title: 'You have the 2nd highest errors', text: `${me.errors.toLocaleString()} error(s) in ${label}. Slow down a little and review your work to bring this down.` };
  else if (er === 3) err = { cls: 'warn', icon: '⚠️', title: 'You have the 3rd highest errors', text: `${me.errors.toLocaleString()} error(s) in ${label}. A little more checking will bring this down.` };
  else err = { cls: 'info', icon: '🔎', title: `${me.errors.toLocaleString()} error(s) recorded`, text: `You are outside the top 3 for errors in ${label}. Keep your accuracy improving!` };
  return [out, err];
}

function performanceSection() {
  const rk = rankings(lbPeriod);
  const label = periodLabel(lbPeriod);
  const tabs = `<div class="lb-tabs">${[['month', 'This month'], ['prev', 'Last month'], ['all', 'All time']].map(([k, l]) => `<button type="button" class="lb-tab ${lbPeriod === k ? 'active' : ''}" data-lb-period="${k}">${l}</button>`).join('')}</div>`;
  const head = `<div class="panel-head" style="margin:0 0 12px"><div><h3>🏆 ${isAdmin() ? 'Team performance' : 'My standing'}</h3><p>${esc(label)} · rejected shifts are not counted</p></div>${tabs}</div>`;
  if (isAdmin()) {
    return `<div class="perf">${head}<div class="grid-2">${top5Panel('Top 5 performers', 'Most receipts processed · ' + esc(label), rk.byOut, 'out')}${top5Panel('Top 5 most errors', 'Highest error count · ' + esc(label), rk.byErr, 'err')}</div></div>`;
  }
  const cards = workerStandings(rk, lbPeriod).map(c => `<div class="standing ${c.cls}"><div class="standing-ico">${c.icon}</div><div><b>${esc(c.title)}</b><p>${esc(c.text)}</p></div></div>`).join('');
  const warn = lbError ? `<div class="notice warn" style="margin-bottom:10px">Team ranking could not be loaded. Update your Firestore rules for the "leaderboard" collection.</div>` : '';
  return `<div class="perf">${head}${warn}<div class="standing-grid">${cards}</div></div>`;
}

/* ───────────────────────── Team chat: popups, badge, live feed ───────────────────────── */
function updateChatBadge() {
  const b = $('[data-nav="chat"]');
  if (!b) return;
  b.querySelector('.nav-badge')?.remove();
  if (unreadChat > 0) b.insertAdjacentHTML('beforeend', `<span class="nav-badge">${unreadChat > 9 ? '9+' : unreadChat}</span>`);
}

function showChatPopup(m) {
  let box = $('#chatPopups');
  if (!box) { box = document.createElement('div'); box.id = 'chatPopups'; document.body.appendChild(box); }
  while (box.children.length >= 3) box.firstChild.remove();
  const t = String(m.text || m.message || '');
  const el = document.createElement('div');
  el.className = 'chat-pop';
  el.innerHTML = `<div class="avatar">${esc(initials(m.senderName))}</div><div class="chat-pop-body"><b>💬 ${esc(m.senderName || 'Team member')}</b><span>${esc(t.length > 160 ? t.slice(0, 160) + '…' : t)}</span><small>New team message · click to open chat</small></div><button type="button" class="chat-pop-x" aria-label="Dismiss">×</button>`;
  el.addEventListener('click', e => {
    if (e.target.closest('.chat-pop-x')) { el.remove(); return; }
    el.remove();
    go('chat');
  });
  box.appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

function onIncomingMessage(m) {
  if (!currentUser || !profile) return;
  if (page === 'chat' && !document.hidden) return; // already reading the chat
  unreadChat++;
  updateChatBadge();
  showChatPopup(m);
}

function liveFeedHtml() {
  const msgs = (data.messages || []).slice(-6);
  if (!msgs.length) return '<div class="empty">💬<b>No messages yet</b>Start the conversation in Team chat.</div>';
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

/* ───────────────────────── Demo mode ───────────────────────── */
function demoSignIn(role) {
  unlisten();
  const admin = role === 'admin';
  currentUser = { uid: admin ? 'demo-admin' : 'demo-worker', email: admin ? 'admin@demo.local' : 'worker@demo.local', displayName: admin ? 'Demo Administrator' : 'Demo Worker' };
  profile = { id: currentUser.uid, email: currentUser.email, displayName: currentUser.displayName, role, isActive: true, status: 'approved', assignedAccountIds: ['abk-01'] };
  data.accounts = [{ id: 'abk-01', name: 'Abukai Team Alpha', code: 'ABK-01', isActive: true, assignedWorkerIds: ['demo-worker'], assignedWorkerNames: ['Demo Worker'] }];
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
  data.leaderboard = [];
  data.settings = { ...DEFAULT_SETTINGS };
  page = 'dashboard';
  unreadChat = 0;
  renderPage();
  toast('Demo mode: changes are not saved online.');
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
  $('#confirmBox')?.remove();
  $('#chatPopups')?.remove();
  unreadChat = 0;
  $('#app').innerHTML = `<main class="login-wrap"><section class="login-art"><div class="brand"><img src="assets/logo.jpg" alt=""><div><strong>STEIVY</strong><small>RECEIPT HUB</small></div></div><div><h1>Keep every shift<br>in good order.</h1><p>Manage receipt submissions, track shift totals, review reports, and stay connected with your team.</p></div><div class="art-foot"><p>One hub for your team's daily operations.</p></div></section><section class="login-form-side"><form id="loginForm" class="login-form"><div class="brand-mark">S</div><h2>Welcome back</h2><p class="muted">Sign in to continue to your workspace.</p>${!configured ? `<div class="demo-note"><b>Firebase setup required</b><br>This copy has no Firebase web credentials yet. You can preview the interface with demo accounts below; demo changes are not saved online.</div>` : ''}<div class="field"><label for="email">EMAIL ADDRESS</label><input id="email" type="email" placeholder="you@company.com" autocomplete="username" required></div><div class="field"><label for="password">PASSWORD</label><input id="password" type="password" placeholder="Enter your password" autocomplete="current-password" required></div><button class="btn btn-primary btn-block" type="submit">Sign in <span>→</span></button><p class="muted" style="font-size:12px;text-align:center;margin:18px 0">Need an account? Ask your administrator to create or approve it.</p>${!configured ? `<div class="field"><label>PREVIEW WITHOUT FIREBASE</label><button class="btn btn-light btn-block" type="button" id="demoWorker">Continue as demo worker</button><button class="btn btn-ghost btn-block" style="margin-top:8px" type="button" id="demoAdmin">Preview admin dashboard</button></div>` : ''}<div class="footer-note">Steivy Receipt Hub · Web edition</div></form></section></main>`;

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
  $('#demoWorker')?.addEventListener('click', () => demoSignIn('worker'));
  $('#demoAdmin')?.addEventListener('click', () => demoSignIn('admin'));
}

/* ───────────────────────── Layout ───────────────────────── */
const PAGE_TITLES = { dashboard: 'Dashboard', receipts: 'Receipt submissions', errors: 'Error processed', accounts: 'Account management', reports: 'Reports & earnings', chat: 'Team chat', workers: 'Worker management', settings: 'Pay settings' };
const allowedPages = () => isAdmin() ? ['dashboard', 'receipts', 'errors', 'accounts', 'reports', 'chat', 'workers', 'settings'] : ['dashboard', 'receipts', 'errors', 'reports', 'chat'];

function shell() {
  const items = [['dashboard', '⌂', 'Dashboard'], ['receipts', '▤', 'Submissions'], ['errors', '⚠', 'Error processed']];
  if (isAdmin()) items.push(['accounts', '▦', 'Accounts']);
  items.push(['reports', '▥', 'Reports'], ['chat', '☏', 'Team chat']);
  if (isAdmin()) items.push(['workers', '♙', 'Workers'], ['settings', '⚙', 'Pay settings']);
  const title = PAGE_TITLES[page] || 'Dashboard';
  const badge = k => k === 'chat' && unreadChat > 0 ? `<span class="nav-badge">${unreadChat > 9 ? '9+' : unreadChat}</span>` : '';
  return `<div class="shell"><aside class="sidebar" id="sidebar"><div class="brand"><img src="assets/logo.jpg" alt=""><div><strong>STEIVY</strong><small>RECEIPT HUB</small></div></div><div class="nav-label">WORKSPACE</div><nav class="nav">${items.map(n => `<button data-nav="${n[0]}" class="${page === n[0] ? 'active' : ''}"><span class="ico">${n[1]}</span>${n[2]}${badge(n[0])}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="user-mini"><div class="avatar">${esc(initials(profile?.displayName))}</div><div><strong>${esc(profile?.displayName || 'User')}</strong><small>${isAdmin() ? 'Administrator' : 'Worker'}</small></div></div><button class="btn btn-ghost btn-block" id="logout">↪ Sign out</button></div></aside><main class="main"><header class="topbar"><div class="right"><button class="btn btn-ghost mobile-menu" id="menuBtn">☰</button><div><div class="crumb">WORKSPACE / ${esc(title.toUpperCase())}</div><h1>${esc(title)}</h1></div></div><div class="top-actions"><span class="mode-pill">${configured ? '● Connected app' : '◉ Demo preview'}</span><div class="avatar">${esc(initials(profile?.displayName))}</div></div></header>${!configured ? '<div class="demo-banner">Demo preview — data is sample-only and will reset when you leave. Configure Firebase to use real accounts and save changes.</div>' : ''}<section class="content" id="pageContent"></section></main></div>`;
}

const stat = (label, value, sub, ico) => `<div class="stat"><div class="stat-head">${label}<span class="stat-icon">${ico}</span></div><strong>${value}</strong><small>${sub}</small></div>`;
const status = s => `<span class="status ${esc(String(s || 'pending').toLowerCase())}">${esc(s || 'pending')}</span>`;

/* ───────────────────────── Pages ───────────────────────── */
function submissionRows(rows) {
  if (!rows.length) return `<tr><td colspan="8"><div class="empty">▤<b>No submissions yet</b>Shift submissions will appear here.</div></td></tr>`;
  return rows.slice().sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt)).map(s => {
    const err = num(s.errorCount);
    return `<tr><td><div class="person"><div class="avatar">${esc(initials(s.workerName))}</div><div><strong>${esc(s.workerName || 'Worker')}</strong><small>${esc(s.accountName || 'No account')}</small></div></div></td><td>${esc(date(s.shiftDate))}</td><td>${esc(s.shiftType || '—')}<small style="display:block;color:#8a958e;margin-top:4px">${esc(s.startTime || '')} – ${esc(s.endTime || '')}</small></td><td>${num(s.receiptCount).toLocaleString()}</td><td${err > 0 ? ' style="color:#c0392b;font-weight:600"' : ''}>${err.toLocaleString()}</td><td>${money(s.netCents)}</td><td>${status(s.status)}</td><td><div class="sh-row-actions"><button class="small-btn" data-view="${esc(s.id)}">View</button>${isAdmin() ? `<button class="small-btn" data-edit-counts="${esc(s.id)}">Edit</button>` : ''}</div></td></tr>`;
  }).join('');
}

function dashboard() {
  const rows = visibleSubmissions();
  const approved = rows.filter(s => s.status === 'approved');
  const pending = rows.filter(s => s.status === 'pending');
  const total = rows.reduce((n, s) => n + num(s.receiptCount), 0);
  const errTotal = rows.reduce((n, s) => n + num(s.errorCount), 0);
  const earned = approved.reduce((n, s) => n + num(s.netCents), 0);
  const recent = rows.slice().sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt)).slice(0, 5);
  const first = esc((profile.displayName || 'there').split(' ')[0]);
  return `<div class="welcome"><div><h2>${isAdmin() ? 'Good day, Administrator' : 'Welcome back, ' + first + ' 👋'}</h2><p>Here’s what’s happening with ${isAdmin() ? 'your team' : 'your shifts'} today.</p></div>${!isAdmin() ? '<button class="btn btn-primary" data-page="receipts">＋ Submit shift</button>' : '<button class="btn btn-primary" data-page="receipts">Review submissions →</button>'}</div>${onlineStrip()}<div class="stats">${stat(isAdmin() ? 'Total submissions' : 'My submissions', rows.length, isAdmin() ? 'All recorded shifts' : 'Your recorded shifts', '▤')}${stat('Receipts processed', total.toLocaleString(), `${errTotal.toLocaleString()} error(s) recorded`, '▧')}${stat('Pending review', pending.length, 'Awaiting a decision', '◷')}${stat(isAdmin() ? 'Approved net pay' : 'Approved earnings', money(earned), 'After configured deductions', '₱')}</div>${monthStats(rows)}${performanceSection()}${liveChatPanel()}${isAdmin() ? announcementsPanel() : ''}<div class="grid-2"><div class="panel"><div class="panel-head"><div><h3>Recent submissions</h3><p>Latest shift records and review status</p></div><button class="small-btn" data-page="receipts">View all →</button></div><div class="table-wrap"><table><thead><tr><th>Worker / account</th><th>Shift date</th><th>Shift</th><th>Processed</th><th>Errors</th><th>Net pay</th><th>Status</th><th></th></tr></thead><tbody>${submissionRows(recent)}</tbody></table></div></div><div class="panel"><div class="panel-head"><div><h3>Quick actions</h3><p>Common tasks, one click away</p></div></div><div class="quick-grid"><button class="quick" data-page="receipts"><span>🧾</span><strong>Submit shift</strong><small>Record receipt count</small></button><button class="quick" data-page="errors"><span>⚠️</span><strong>Error processed</strong><small>Review error receipts</small></button><button class="quick" data-page="reports"><span>📊</span><strong>View reports</strong><small>Track your totals</small></button><button class="quick" data-page="chat"><span>💬</span><strong>Team chat</strong><small>Message your team</small></button>${isAdmin() ? '<button class="quick" data-page="workers"><span>👥</span><strong>Manage workers</strong><small>Review team accounts</small></button>' : ''}</div><div class="notice">${isAdmin() ? `You have <b>${pending.length}</b> submission(s) waiting for review.` : `Your approved submissions show in earnings. If a shift is rejected, check the reason and submit a correction.`}</div></div></div>`;
}

function filteredSubmissions() {
  const q = filters.q.trim().toLowerCase();
  return visibleSubmissions().filter(x => (filters.status === 'all' || x.status === filters.status) &&
    (!q || `${x.workerName || ''} ${x.accountName || ''} ${x.shiftDate || ''}`.toLowerCase().includes(q)));
}

function submissionForm() {
  const uid = currentUser.uid;
  const accts = data.accounts.filter(a => a.isActive !== false && (!a.assignedWorkerIds || a.assignedWorkerIds.includes(uid)));
  return `<div class="panel" id="submissionFormPanel"><div class="panel-head"><div><h3>Submit completed shift</h3><p>Enter your shift details. Pay is calculated on processed receipts using current settings; error receipts are not paid.</p></div></div><form id="submissionForm"><div class="form-grid"><div class="field"><label>ACCOUNT</label><select name="accountId" required>${accts.map(a => `<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.code || '')})</option>`).join('') || '<option value="">No active accounts assigned</option>'}</select></div><div class="field"><label>SHIFT DATE</label><input name="shiftDate" type="date" value="${todayStr()}" max="${todayStr()}" required></div><div class="field"><label>SHIFT</label><select name="shiftType"><option>Morning</option><option>Afternoon</option><option>Night</option><option>Custom</option></select></div><div class="field"><label>PROCESSED RECEIPTS</label><input name="receiptCount" type="number" min="0" step="1" placeholder="e.g. 125" required></div><div class="field"><label>ERROR COUNT</label><input name="errorCount" type="number" min="0" step="1" value="0" placeholder="e.g. 3" required></div><div class="field"><label>START TIME</label><input name="startTime" type="time" value="06:00" required></div><div class="field"><label>END TIME</label><input name="endTime" type="time" value="14:00" required></div><div class="full right" style="justify-content:flex-end;margin:0 0 8px"><button class="btn btn-primary" type="submit" ${accts.length ? '' : 'disabled'}>Submit for review →</button></div></div></form></div>`;
}

function receipts() {
  const rows = filteredSubmissions();
  const sel = v => filters.status === v ? 'selected' : '';
  return `<div class="welcome"><div><h2>${isAdmin() ? 'Review submissions' : 'My shift submissions'}</h2><p>${isAdmin() ? 'Review worker activity, edit processed/error counts, and approve or reject shift records.' : 'Record a completed shift and track its status.'}</p></div>${!isAdmin() ? '<button class="btn btn-primary" id="newSubmission">＋ New submission</button>' : ''}</div>${!isAdmin() ? submissionForm() : ''}<div class="panel"><div class="toolbar"><input id="receiptSearch" placeholder="Search worker or account…" value="${esc(filters.q)}"><select id="statusFilter"><option value="all">All statuses</option><option ${sel('pending')}>pending</option><option ${sel('approved')}>approved</option><option ${sel('rejected')}>rejected</option></select><span class="spacer"></span><span class="muted" id="recordCount">${rows.length} record(s)</span></div><div class="table-wrap"><table><thead><tr><th>Worker / account</th><th>Shift date</th><th>Shift</th><th>Processed</th><th>Errors</th><th>Net pay</th><th>Status</th><th>Action</th></tr></thead><tbody id="submissionRows">${submissionRows(rows)}</tbody></table></div></div>`;
}

function workerNamesFor(a) {
  const byId = new Map(data.users.map(u => [u.id, u.displayName || u.email]));
  const names = (a.assignedWorkerIds || []).map((id, i) => byId.get(id) || a.assignedWorkerNames?.[i]).filter(Boolean);
  return names.length ? names.join(', ') : 'Not assigned';
}

/* Monthly receipt/error totals per account (rejected submissions are excluded) */
function monthKeyOf(offset = 0) {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const monthLabel = k => {
  const [y, m] = k.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
};
function accountStats(accountId) {
  const cur = monthKeyOf(0), prev = monthKeyOf(-1);
  const r = { cur: { receipts: 0, errors: 0 }, prev: { receipts: 0, errors: 0 } };
  data.submissions.forEach(s => {
    if (s.accountId !== accountId || s.status === 'rejected') return;
    const k = String(s.shiftDate || '').slice(0, 7);
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

  return `<div class="welcome"><div><h2>Accounts</h2><p>Abukai accounts, worker assignments, and monthly receipt totals.</p></div>${isAdmin() ? '<button class="btn btn-primary" id="addAccount">＋ Add account</button>' : ''}</div><div class="panel">${data.accounts.length ? `<div class="table-wrap"><table><thead><tr><th colspan="3"></th><th colspan="2" style="text-align:center">Last month · ${esc(prevLabel)}</th><th colspan="2" style="text-align:center">This month · ${esc(curLabel)}</th><th colspan="3"></th></tr><tr><th>Account</th><th>Code</th><th>Assigned workers</th><th>Receipts</th><th>Errors</th><th>Receipts</th><th>Errors</th><th>Status</th><th>Notes</th><th>Action</th></tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div><div class="notice" style="margin-top:12px">Totals use the shift date and count processed receipts and errors from pending and approved submissions. Rejected submissions are not counted.</div>` : `<div class="empty">▦<b>No accounts available</b>Ask an administrator to create an account and assign workers.</div>`}</div>`;
}

/* ───────────────────────── Error processed ───────────────────────── */
function errorsPage() {
  const all = visibleSubmissions();
  const rows = all.filter(s => num(s.errorCount) > 0).sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt));
  const totalErr = rows.reduce((n, s) => n + num(s.errorCount), 0);
  const totalProcessed = all.reduce((n, s) => n + num(s.receiptCount), 0);
  const overall = totalProcessed + totalErr > 0 ? (totalErr / (totalProcessed + totalErr) * 100).toFixed(1) : '0.0';

  const body = rows.length ? rows.map(s => {
    const p = num(s.receiptCount), er = num(s.errorCount);
    const rt = p + er > 0 ? (er / (p + er) * 100).toFixed(1) : '0.0';
    return `<tr><td><div class="person"><div class="avatar">${esc(initials(s.workerName))}</div><div><strong>${esc(s.workerName || 'Worker')}</strong><small>${esc(s.accountName || 'No account')}</small></div></div></td><td>${esc(date(s.shiftDate))}</td><td>${esc(s.shiftType || '—')}</td><td>${p.toLocaleString()}</td><td style="color:#c0392b;font-weight:600">${er.toLocaleString()}</td><td>${rt}%</td><td>${esc(s.errorNote || '—')}</td><td>${status(s.status)}</td><td><div class="sh-row-actions"><button class="small-btn" data-view="${esc(s.id)}">View</button>${isAdmin() ? `<button class="small-btn" data-edit-counts="${esc(s.id)}">Edit</button>` : ''}</div></td></tr>`;
  }).join('') : `<tr><td colspan="9"><div class="empty">✓<b>No errors recorded</b>Submissions with an error count above zero will appear here.</div></td></tr>`;

  return `<div class="welcome"><div><h2>${isAdmin() ? 'Error processed' : 'My error processed'}</h2><p>${isAdmin() ? 'Shifts with error receipts. Use Edit to correct processed or error counts.' : 'Shifts where you recorded error receipts.'}</p></div></div><div class="stats">${stat('Total errors', totalErr.toLocaleString(), 'Across listed submissions', '⚠')}${stat('Shifts with errors', rows.length, `of ${all.length} submission(s)`, '▤')}${stat('Error rate', overall + '%', 'Errors ÷ (processed + errors)', '%')}${stat('Processed receipts', totalProcessed.toLocaleString(), 'Paid receipts', '✓')}</div><div class="panel"><div class="table-wrap"><table><thead><tr><th>Worker / account</th><th>Shift date</th><th>Shift</th><th>Processed</th><th>Errors</th><th>Error rate</th><th>Note</th><th>Status</th><th>Action</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function reports() {
  const rows = visibleSubmissions();
  const approved = rows.filter(s => s.status === 'approved');
  const gross = approved.reduce((n, s) => n + num(s.grossCents), 0);
  const deduct = approved.reduce((n, s) => n + num(s.deductionCents), 0);
  const net = approved.reduce((n, s) => n + num(s.netCents), 0);
  const months = {};
  approved.forEach(s => { const k = String(s.shiftDate || 'Unknown').slice(0, 7); months[k] = (months[k] || 0) + num(s.netCents); });
  const max = Math.max(1, ...Object.values(months));

  let perWorker = '';
  if (isAdmin()) {
    const g = {};
    approved.forEach(s => {
      const k = s.workerId || s.workerName || 'unknown';
      g[k] ||= { name: s.workerName || 'Worker', shifts: 0, receipts: 0, net: 0 };
      g[k].shifts++; g[k].receipts += num(s.receiptCount); g[k].net += num(s.netCents);
    });
    const list = Object.values(g).sort((a, b) => b.net - a.net);
    perWorker = `<div class="panel"><div class="panel-head"><div><h3>By worker</h3><p>Approved shifts only</p></div></div><div class="table-wrap"><table><thead><tr><th>Worker</th><th>Shifts</th><th>Receipts</th><th>Net pay</th></tr></thead><tbody>${list.map(w => `<tr><td><strong>${esc(w.name)}</strong></td><td>${w.shifts}</td><td>${w.receipts.toLocaleString()}</td><td>${money(w.net)}</td></tr>`).join('') || '<tr><td colspan="4"><div class="empty">No approved shifts yet.</div></td></tr>'}</tbody></table></div></div>`;
  }

  return `<div class="welcome"><div><h2>${isAdmin() ? 'Team reports' : 'My earnings'}</h2><p>Approved submissions only are included in pay totals.</p></div><button class="btn btn-ghost" id="exportCsv">↓ Export CSV</button></div><div class="stats">${stat('Gross pay', money(gross), 'Before deductions', '₱')}${stat('Deductions', money(deduct), `${dedPct()}% configured rate`, '−')}${stat('Net payable', money(net), 'Approved records', '✓')}${stat('Approved shifts', approved.length, 'Completed and approved', '▤')}</div><div class="grid-2"><div class="panel"><div class="panel-head"><div><h3>Monthly net pay</h3><p>By shift date, approved submissions</p></div></div><div class="report-bars">${Object.entries(months).sort((a, b) => a[0].localeCompare(b[0])).slice(-8).map(([m, v]) => `<div class="bar-line"><span>${esc(m)}</span><div class="bar-track"><div class="bar-fill" style="width:${(v / max * 100).toFixed(1)}%"></div></div><b>${money(v)}</b></div>`).join('') || '<div class="empty">No approved earnings to chart yet.</div>'}</div></div><div class="panel"><div class="panel-head"><div><h3>Calculation details</h3><p>Based on current pay settings</p></div></div><div class="right" style="justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--line)"><span class="muted">Rate per receipt</span><b>${money(rate())}</b></div><div class="right" style="justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--line)"><span class="muted">Deduction rate</span><b>${dedPct()}%</b></div><div class="right" style="justify-content:space-between;padding:14px 0"><span class="muted">Net after deductions</span><b>${money(net)}</b></div><div class="notice">Totals update from Firestore when Firebase is configured. Demo data is illustrative only.</div></div></div>${perWorker}`;
}

function workers() {
  const users = data.users.filter(u => u.role !== 'admin');
  const actions = u => {
    const st = u.status || 'approved';
    const b = [`<button class="small-btn" data-worker="${esc(u.id)}">View</button>`, `<button class="small-btn" data-worker-action="edit" data-id="${esc(u.id)}">Edit</button>`];
    if (st === 'pending' || st === 'rejected') b.push(`<button class="small-btn" data-worker-action="approve" data-id="${esc(u.id)}">Approve</button>`);
    if (st === 'pending') b.push(`<button class="small-btn" data-worker-action="reject" data-id="${esc(u.id)}">Reject</button>`);
    if (st === 'approved') b.push(u.isActive === false
      ? `<button class="small-btn" data-worker-action="activate" data-id="${esc(u.id)}">Activate</button>`
      : `<button class="small-btn" data-worker-action="deactivate" data-id="${esc(u.id)}">Deactivate</button>`);
    b.push(`<button class="btn btn-danger" data-worker-action="delete" data-id="${esc(u.id)}">Delete</button>`);
    return `<div class="sh-row-actions">${b.join('')}</div>`;
  };
  return `<div class="welcome"><div><h2>Worker management</h2><p>Review worker profiles and account status.</p></div><button class="btn btn-primary" id="addWorker">＋ Create worker</button></div><div class="panel"><div class="toolbar"><input id="workerSearch" placeholder="Search name or email…"><span class="spacer"></span><span class="muted">${users.length} worker(s)</span></div><div class="table-wrap"><table><thead><tr><th>Worker</th><th>Email</th><th>Status</th><th>Assigned accounts</th><th>Action</th></tr></thead><tbody>${users.map(u => `<tr><td><div class="person"><div class="avatar">${esc(initials(u.displayName))}</div><strong>${esc(u.displayName || 'Unnamed')}</strong></div></td><td>${esc(u.email)}</td><td>${status(u.isActive === false ? 'inactive' : (u.status || 'approved'))}</td><td>${(u.assignedAccountIds || []).length}</td><td>${actions(u)}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">No worker profiles found.</div></td></tr>'}</tbody></table></div></div>`;
}

function settings() {
  return `<div class="welcome"><div><h2>Pay settings</h2><p>Configure receipt rate and deductions for future submissions.</p></div></div><div class="panel" style="max-width:650px"><form id="settingsForm"><div class="field"><label>GROSS RATE PER RECEIPT (PHP)</label><input name="rate" type="number" min="0" step="0.01" value="${(rate() / 100).toFixed(2)}" required></div><div class="field"><label>DEDUCTION PERCENT (%)</label><input name="deduction" type="number" min="0" max="100" step="0.1" value="${dedPct()}" required></div><div class="notice">These values are used for new submissions. Updating settings does not automatically recalculate historical submissions.</div><button class="btn btn-primary" type="submit">Save settings</button></form></div>`;
}

function chatBubbles() {
  const messages = data.messages || [];
  return messages.map(m => {
    const mine = m.senderId === currentUser?.uid;
    return `<div class="bubble ${mine ? 'mine' : ''}">${!mine ? `<b>${esc(m.senderName || 'Team member')}</b><br>` : ''}${esc(m.text || m.message || '')}<small>${esc(fmtTime(m.createdAt))}</small></div>`;
  }).join('') || '<div class="empty">💬<b>No messages yet</b>Start the conversation with your team.</div>';
}
function updateChat() {
  const box = $('#chatMessages');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const lastMine = (data.messages || []).slice(-1)[0]?.senderId === currentUser?.uid;
  box.innerHTML = chatBubbles();
  if (nearBottom || lastMine) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
}
function chat() {
  return `<div class="welcome"><div><h2>Team conversation</h2><p>Share updates with your team.</p></div></div><div class="chat-layout"><div class="chat-list"><button class="active"><div class="avatar">👥</div><div><strong>Company group</strong><small>Team-wide conversation</small></div></button></div><div class="chat-window"><div class="chat-messages" id="chatMessages">${chatBubbles()}</div><form class="chat-compose" id="chatForm"><input name="message" placeholder="Write a message…" maxlength="2000" autocomplete="off" required><button class="btn btn-primary" type="submit">Send ↗</button></form></div></div>`;
}

/* ───────────────────────── Render + wiring ───────────────────────── */
function renderPage() {
  if (!currentUser || !profile) { renderLogin(); return; }
  pendingRender = false;
  if (!allowedPages().includes(page)) page = 'dashboard';
  if (page === 'chat') unreadChat = 0;
  $('#app').innerHTML = shell();
  $('#pageContent').innerHTML = ({ dashboard, receipts, errors: errorsPage, accounts, reports, chat, workers, settings })[page]();
  wireShell();
  wirePage();
  if (detailId) { const s = visibleSubmissions().find(x => x.id === detailId); if (s) viewSubmission(s.id, false); else detailId = null; }
  syncAnnouncementPopup();
}

function go(p) {
  page = p;
  detailId = null;
  if (p === 'chat') unreadChat = 0;
  renderPage();
  window.scrollTo(0, 0);
}

function wireShell() {
  $$('.nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.nav)));
  $('#logout')?.addEventListener('click', async () => {
    await stopPresence();
    unlisten();
    if (configured && auth) { try { await fb.signOut(auth); } catch {} }
    currentUser = null; profile = null; page = 'dashboard'; detailId = null;
    renderLogin();
  });
  $('#menuBtn')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#pageContent').addEventListener('click', e => {
    const t = e.target;
    let el;
    if ((el = t.closest('[data-lb-period]'))) { lbPeriod = el.dataset.lbPeriod; return renderPage(); }
    if ((el = t.closest('[data-page]'))) return go(el.dataset.page);
    if ((el = t.closest('[data-view]'))) return viewSubmission(el.dataset.view);
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
  $('#submissionForm')?.addEventListener('submit', submitShift);
  $('#receiptSearch')?.addEventListener('input', e => { filters.q = e.target.value; filterRows(); });
  $('#statusFilter')?.addEventListener('change', e => { filters.status = e.target.value; filterRows(); });
  $('#addAccount')?.addEventListener('click', addAccount);
  $('#addWorker')?.addEventListener('click', addWorker);
  $('#addAnnouncement')?.addEventListener('click', addAnnouncement);
  $('#settingsForm')?.addEventListener('submit', saveSettings);
  $('#chatForm')?.addEventListener('submit', sendMessage);
  $('#exportCsv')?.addEventListener('click', exportCsv);
  $('#workerSearch')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $$('#pageContent tbody tr').forEach(r => r.classList.toggle('hidden', !r.textContent.toLowerCase().includes(q)));
  });
  const cm = $('#chatMessages');
  if (cm) cm.scrollTop = cm.scrollHeight;
  const lc = $('#liveChat');
  if (lc) lc.scrollTop = lc.scrollHeight;
}

function filterRows() {
  const rows = filteredSubmissions();
  const body = $('#submissionRows');
  if (body) body.innerHTML = submissionRows(rows);
  const c = $('#recordCount');
  if (c) c.textContent = rows.length + ' record(s)';
}

/* ───────────────────────── Submissions ───────────────────────── */
async function submitShift(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('[type=submit]');
  if (btn.disabled) return;
  btn.disabled = true; // lock immediately so a double click cannot create two submissions
  const fail = msg => { toast(msg); btn.disabled = false; };

  const f = new FormData(form);
  const account = data.accounts.find(a => a.id === f.get('accountId'));
  if (!account) return fail('Select an active account first.');
  const shiftDate = f.get('shiftDate');
  if (shiftDate > todayStr()) return fail('Shift date cannot be in the future.');
  const count = parseInt(f.get('receiptCount'), 10);
  if (!Number.isFinite(count) || count < 0) return fail('Enter a valid processed receipt count.');
  const errCount = parseInt(f.get('errorCount') || '0', 10);
  if (!Number.isFinite(errCount) || errCount < 0) return fail('Enter a valid error count.');
  const shiftType = f.get('shiftType');

  const dup = visibleSubmissions().find(s => s.accountId === account.id && s.shiftDate === shiftDate && s.shiftType === shiftType && s.status !== 'rejected' && s.workerId === currentUser.uid);
  if (dup && !await confirmBox('Duplicate shift?', 'You already submitted a ' + shiftType + ' shift for this account on this date. Submit another anyway?', 'Yes, submit again')) { btn.disabled = false; return; }

  const rateCents = rate(), pct = dedPct();
  const gross = Math.round(count * rateCents);
  const ded = Math.round(gross * pct / 100);
  const item = {
    workerId: currentUser.uid, workerName: profile.displayName, workerEmail: currentUser.email,
    accountId: account.id, accountName: account.name,
    shiftDate, shiftType, startTime: f.get('startTime'), endTime: f.get('endTime'),
    receiptCount: count, errorCount: errCount, errorNote: '',
    status: 'pending', rejectionReason: '',
    rateCents, deductionPercent: pct,
    grossCents: gross, deductionCents: ded, netCents: gross - ded
  };

  if (!configured) {
    data.submissions.unshift({ ...item, id: 'local-' + Date.now(), createdAt: new Date(), updatedAt: new Date() });
    toast('Demo submission added (not saved online).');
    renderPage();
    return;
  }
  try {
    await fb.addDoc(fb.collection(db, 'submissions'), { ...item, createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp() });
    toast('Shift submitted for review.');
    form.reset();
    renderPage();
  } catch (err) {
    console.error(err);
    toast('Submission failed. Check Firestore permissions and assigned account.');
    btn.disabled = false;
  }
}

function viewSubmission(id, scroll = true) {
  const s = visibleSubmissions().find(x => x.id === id);
  if (!s) return;
  detailId = id;
  const processed = num(s.receiptCount), errs = num(s.errorCount);
  const errRate = processed + errs > 0 ? (errs / (processed + errs) * 100).toFixed(1) + '%' : '0%';
  const actions = (isAdmin() ? `<button class="btn btn-secondary" id="editCountsBtn">Edit counts</button>` : '') +
    (isAdmin() && s.status === 'pending' ? `<button class="btn btn-primary" id="approveOne">Approve</button><button class="btn btn-danger" id="rejectOne">Reject</button>` : '');
  const reason = s.rejectionReason ? `<div class="notice warn">Rejection reason: ${esc(s.rejectionReason)}</div>` : '';
  const errNote = s.errorNote ? `<div class="notice">Error note: ${esc(s.errorNote)}</div>` : '';
  const html = `<div class="panel"><div class="panel-head"><div><h3>Submission details</h3><p>${esc(s.id)}</p></div><button class="btn btn-ghost" id="closeDetails">Close</button></div><div class="form-grid"><div><p class="muted">Worker</p><b>${esc(s.workerName)}</b></div><div><p class="muted">Status</p>${status(s.status)}</div><div><p class="muted">Account</p><b>${esc(s.accountName)}</b></div><div><p class="muted">Shift date</p><b>${esc(date(s.shiftDate))}</b></div><div><p class="muted">Shift hours</p><b>${esc(s.startTime)} – ${esc(s.endTime)}</b></div><div><p class="muted">Processed receipts</p><b>${processed.toLocaleString()}</b></div><div><p class="muted">Error count</p><b${errs > 0 ? ' style="color:#c0392b"' : ''}>${errs.toLocaleString()}</b></div><div><p class="muted">Error rate</p><b>${errRate}</b></div><div><p class="muted">Gross pay</p><b>${money(s.grossCents)}</b></div><div><p class="muted">Deductions</p><b>${money(s.deductionCents)}</b></div><div><p class="muted">Net pay</p><b>${money(s.netCents)}</b></div></div>${errNote}${reason}<div class="right" style="justify-content:flex-end;margin-top:20px;gap:8px">${actions}</div></div>`;
  $('#detailsPanel')?.remove();
  $('#pageContent').insertAdjacentHTML('afterbegin', `<div id="detailsPanel">${html}</div>`);
  $('#closeDetails').onclick = () => { detailId = null; $('#detailsPanel')?.remove(); };
  $('#editCountsBtn')?.addEventListener('click', () => editCounts(s.id));
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
    toast('Demo record updated only.');
    renderPage();
    return;
  }
  try {
    await fb.updateDoc(fb.doc(db, 'submissions', s.id), {
      status: statusValue, rejectionReason: reason,
      reviewedBy: currentUser.uid, reviewedAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp()
    });
    detailId = null;
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
     <div class="field"><label>PROCESSED RECEIPTS</label><input name="receiptCount" type="number" min="0" step="1" value="${num(s.receiptCount)}" required></div>
     <div class="field"><label>ERROR COUNT</label><input name="errorCount" type="number" min="0" step="1" value="${num(s.errorCount)}" required></div>
     <div class="field"><label>ERROR NOTE (OPTIONAL)</label><input name="errorNote" maxlength="200" value="${esc(s.errorNote || '')}" placeholder="e.g. Blurry images, wrong amounts"></div>
     <div class="notice">Pay is recalculated from the processed count using the rate saved on this submission. Error receipts are not paid.</div>`,
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

      if (!configured) {
        Object.assign(s, changes, { updatedAt: new Date() });
        toast('Demo counts updated (not saved online).');
        renderPage();
        return;
      }
      await fb.updateDoc(fb.doc(db, 'submissions', s.id), {
        ...changes, editedBy: currentUser.uid, editedAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp()
      });
      toast('Counts updated and pay recalculated.');
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
    await commitInChunks(ops);
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
    <div><p class="muted">Assigned accounts</p><b>${esc(accts.join(', ') || 'None')}</b></div></div>`, null);
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
      if (data.users.some(u => (u.email || '').toLowerCase() === email)) { toast('A worker with that email already exists.'); return false; }

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
        toast('Worker created.');
      } catch (err) {
        console.error(err);
        toast(err.code === 'auth/email-already-in-use' ? 'That email already has a login.'
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
  if (!await confirmBox('Delete worker?', `Are you sure you want to delete ${u.displayName || u.email}? Their profile will be removed and they will lose access. Past submissions are kept. This cannot be undone.`, 'Yes, delete', true)) return;

  if (!configured) {
    data.users = data.users.filter(x => x.id !== u.id);
    data.accounts.forEach(a => {
      a.assignedWorkerIds = (a.assignedWorkerIds || []).filter(id => id !== u.id);
    });
    toast('Demo worker deleted.');
    renderPage();
    return;
  }
  try {
    const ops = [b => b.delete(fb.doc(db, 'users', u.id))];
    data.accounts.filter(a => (a.assignedWorkerIds || []).includes(u.id)).forEach(a => {
      ops.push(b => b.update(fb.doc(db, 'accounts', a.id), {
        assignedWorkerIds: fb.arrayRemove(u.id),
        updatedAt: fb.serverTimestamp()
      }));
    });
    // Remove their ranking totals so they no longer appear in team rankings.
    data.leaderboard.filter(d => d.workerId === u.id).forEach(d => ops.push(b => b.delete(fb.doc(db, 'leaderboard', d.id))));
    await commitInChunks(ops);
    try { await fb.deleteDoc(fb.doc(db, 'presence', u.id)); } catch {} // best effort: stop showing them as online
    toast('Worker deleted.');
  } catch (e) { console.error(e); toast('Could not delete worker. Check Firestore rules.'); }
}

async function workerAction(id, action) {
  if (!isAdmin()) return;
  const u = data.users.find(x => x.id === id);
  if (!u) return;
  if (action === 'delete') return deleteWorker(u);
  if (action === 'edit') return editWorker(u);
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
    toast('Worker updated.');
  } catch (e) { console.error(e); toast('Could not update worker. Check Firestore rules.'); }
}

/* ───────────────────────── Settings, chat, export ───────────────────────── */
async function saveSettings(e) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  const rateVal = Number(f.get('rate')), deduction = Number(f.get('deduction'));
  if (!Number.isFinite(rateVal) || rateVal < 0) return toast('Enter a valid rate.');
  if (!Number.isFinite(deduction) || deduction < 0 || deduction > 100) return toast('Deduction must be between 0 and 100.');
  if (!await confirmBox('Save pay settings?', 'Are you sure you want to change the rate and deduction for future submissions?', 'Yes, save settings')) return;
  const gross = Math.round(rateVal * 100);
  if (!configured) {
    data.settings = { grossRateCents: gross, deductionPercent: deduction };
    toast('Demo settings updated only.');
    renderPage();
    return;
  }
  try {
    await fb.setDoc(fb.doc(db, 'settings', 'paySettings'), {
      id: 'paySettings', grossRateCents: gross, deductionPercent: deduction,
      updatedBy: currentUser.uid, updatedAt: fb.serverTimestamp()
    }, { merge: true });
    toast('Pay settings saved.');
  } catch (err) { console.error(err); toast('Could not save settings. Check Firestore rules.'); }
}

async function sendMessage(e) {
  e.preventDefault();
  const input = e.currentTarget.elements.message;
  const text = input.value.trim();
  if (!text) return;
  const item = { senderId: currentUser.uid, senderName: profile.displayName, text };
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

function exportCsv() {
  const rows = visibleSubmissions().slice().sort((a, b) => timeVal(b.createdAt) - timeVal(a.createdAt));
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
  a.download = `steivy-receipt-report-${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ───────────────────────── Boot ───────────────────────── */
async function boot() {
  const ok = await initFirebase();
  if (!ok) { renderLogin(); return; }

  fb.onAuthStateChanged(auth, async user => {
    const token = ++authToken;
    unlisten();
    closeModal();
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
    } catch (e) {
      console.error(e);
      toast('Could not load your profile. Check Firestore rules.');
      renderLogin();
    }
  });
}

boot();
