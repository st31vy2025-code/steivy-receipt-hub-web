# Month-reset fix: Abukai counter goes back to 0 at 8:00 AM (Philippine time) on the 1st

## Unsay problema
Ang Abukai **"submitted receipts this month"** mo-balik sa **0** kada **8:00 AM Philippine time sa 1st** sa bulan.
8:00 AM Philippine time = **00:00 UTC**, mao nga ang "Abukai month" kay **UTC month**.

Sa karon nga code:
1. Ang shift nga nag-cross sa 8:00 AM (pananglitan **2 AM – 10 AM** o **6 PM – 10 AM** sa 1st) kay mo-error sa **End shift**, kay ang end totals mas ubos pa sa start totals.
2. Ang "This month / Last month" sa dashboard, leaderboard, accounts ug reports kay nagsunod sa **petsa sa device** (12:00 AM), dili sa 8:00 AM reset.

## Unsay mausab (6 ka lakang)

---
### Lakang 1: Idugang ang mga helper
Sa **taas**, ilalom sa linya `const dedPct = () => ...;`, i-paste kini:

```js
/* ───────────────────────── Abukai month reset ─────────────────────────
   Abukai's "this month" counter goes back to 0 at 8:00 AM Philippine time (UTC+8) on the 1st of the month.
   8:00 AM Philippine time = 00:00 UTC, so the Abukai month is simply the UTC month. */
const abkMonthOf = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const abkMonthStart = ms => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }; // the reset moment of the month that contains ms
const abkResetBetween = (a, b) => abkMonthOf(a) !== abkMonthOf(b);                                                   // true if a reset happened between two moments
const nextResetMs = () => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1); };
const subMonth = s => s.abkMonth || String(s.shiftDate || '').slice(0, 7); // the Abukai month a submission belongs to (old records fall back to the shift date)

// Warning on the tracker shortly before the reset
function resetNoticeHtml() {
  const mins = Math.round((nextResetMs() - Date.now()) / 60000);
  if (mins > 0 && mins <= 120) return `<div class="notice warn" style="margin-bottom:12px">⏰ Abukai's monthly counter goes back to <b>0</b> at <b>8:00 AM (Philippine time)</b>, in about ${mins} minute(s). Best: press <b>End shift</b> before then and <b>Start shift</b> again after the reset.</div>`;
  return '';
}

// Turns one worker shift into one record per Abukai month (a shift that crosses the reset becomes two records).
//   base  = stats pasted at Start shift      en  = stats pasted at End shift
//   pre   = optional { submitted, errors } the worker saw just BEFORE the reset (only used when the shift crossed it)
function computeShiftParts({ base, en, startMs, nowMs, pre }) {
  const b = { submitted: num(base?.submitted), errors: num(base?.errors) };
  if (!abkResetBetween(startMs, nowMs)) {
    const count = en.submitted - b.submitted, errs = en.errors - b.errors;
    if (count < 0 || errs < 0) return { error: 'These totals are lower than your start totals (wrong page?). Ask the admin to release this shift.' };
    if (errs > count) return { error: 'These totals look inconsistent (more errors than receipts in this shift). Check that you copied the right page.' };
    return { parts: [{ count, errs, month: abkMonthOf(nowMs), from: startMs, to: nowMs, s0: b, s1: en, part: '' }], note: '' };
  }
  const resetMs = abkMonthStart(nowMs);
  const parts = [];
  let note = '';
  if (pre) {
    const c1 = pre.submitted - b.submitted, e1 = pre.errors - b.errors;
    if (!Number.isFinite(c1) || !Number.isFinite(e1) || c1 < 0 || e1 < 0 || e1 > c1) return { error: 'The "before reset" totals do not match your start totals. Please check the numbers.' };
    parts.push({ count: c1, errs: e1, month: abkMonthOf(startMs), from: startMs, to: resetMs, s0: b, s1: { submitted: pre.submitted, errors: pre.errors }, part: 'before-reset' });
  } else {
    note = 'The part of this shift before the 8:00 AM reset was not entered. Admin: add it with Edit counts if needed.';
  }
  parts.push({ count: en.submitted, errs: en.errors, month: abkMonthOf(nowMs), from: resetMs, to: nowMs, s0: { submitted: 0, errors: 0 }, s1: en, part: 'after-reset' });
  return { parts, note };
}
```

---
### Lakang 2: Ilisan ang `monthKeyOf`
Hanapa ang function nga `function monthKeyOf(offset = 0) { ... }` ug ilisi **tibuok** niini:

```js
function monthKeyOf(offset = 0) {
  const n = new Date();
  const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset, 1)); // Abukai month = UTC month (resets 8:00 AM PH time)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
```

---
### Lakang 3: Ilisi ang 6 ka lugar nga nag-group sa bulan
Pislita ang **Ctrl+F** ug pangitaa ang `String(s.shiftDate`. Naay **6 ka resulta**. Sa matag usa, ilisi ang `String(s.shiftDate || '').slice(0, 7)` (o `String(s.shiftDate || 'Unknown').slice(0, 7)`) ug **`subMonth(s)`**:

| Function | Karaan nga linya | Bag-ong linya |
|---|---|---|
| `monthStats` | `.filter(s => s.status === 'approved' && String(s.shiftDate \|\| '').slice(0, 7) === key)` | `.filter(s => s.status === 'approved' && subMonth(s) === key)` |
| `errorWarningPanel` | `... && String(s.shiftDate \|\| '').slice(0, 7) === key);` | `... && subMonth(s) === key);` |
| `boardRows` | `if (!inPeriod(String(s.shiftDate \|\| '').slice(0, 7), period)) return;` | `if (!inPeriod(subMonth(s), period)) return;` |
| `syncLeaderboard` | `const m = String(s.shiftDate \|\| '').slice(0, 7);` | `const m = subMonth(s);` |
| `accountStats` | `const k = String(s.shiftDate \|\| '').slice(0, 7);` | `const k = subMonth(s);` |
| `reports` | `const k = String(s.shiftDate \|\| 'Unknown').slice(0, 7);` | `const k = subMonth(s);` |

Ang mga karaan nga submission (walay `abkMonth`) mogamit gihapon sa petsa sa shift, busa walay madaot.

---
### Lakang 4: Ilisan ang `liveStatsPreview` ug `endShift`
Hanapa ang duha ka function nga `function liveStatsPreview(...)` ug `function endShift(...)` ug ilisi **tibuok** sa duha ngadto niini:

```js
function liveStatsPreview(boxSel, base, crossed = false) {
  const ta = $('#trkPaste'), box = $(boxSel);
  if (!ta || !box) return;
  ta.addEventListener('input', () => {
    const p = parseAbukaiStats(ta.value);
    if (!p) { box.className = 'notice warn'; box.textContent = '⚠ Could not read the stats. Copy the whole Abukai Processing Stats page and paste it again.'; return; }
    if (!base) { box.className = 'notice'; box.innerHTML = `✅ Baseline: <b>${p.submitted.toLocaleString()}</b> submitted · <b>${p.errors.toLocaleString()}</b> with errors`; return; }
    if (crossed) { box.className = 'notice'; box.innerHTML = `✅ After the reset: <b>${p.submitted.toLocaleString()}</b> receipts · <b>${p.errors.toLocaleString()}</b> with errors (counted from 0 at 8:00 AM Philippine time).`; return; }
    const out = p.submitted - base.submitted, er = p.errors - base.errors;
    if (out < 0 || er < 0) { box.className = 'notice warn'; box.textContent = '⚠ These totals are lower than your start totals (wrong page?).'; return; }
    box.className = 'notice';
    box.innerHTML = `✅ Output this shift: <b>${out.toLocaleString()}</b> receipts · <b>${er.toLocaleString()}</b> with errors`;
  });
}

function endShift(accountId) {
  const s = activeShiftOf(accountId);
  if (!s || s.workerId !== currentUser.uid) return toast('You have no running shift on this account.');
  const sc = scheduleOf(profile);
  if (!inWindow(sc)) return toast(`You can only end and submit during your scheduled shift (${sc.label}). Ask the admin if you missed it.`);
  const base = s.startStats || { submitted: 0, errors: 0 };
  const startMs = timeVal(s.startedAt);
  const crossed = abkResetBetween(startMs, Date.now()); // Abukai's counter went back to 0 while this shift was running

  const resetFields = crossed
    ? `<div class="notice warn" style="margin-bottom:12px">⚠ Abukai's monthly counter went back to <b>0</b> at <b>8:00 AM (Philippine time)</b> while your shift was running. The stats you paste above count only the part <b>after</b> the reset. To also be paid for the part <b>before</b> the reset, enter the last totals you saw before 8:00 AM (leave both empty if you do not have them).</div>
       <div class="form-grid" style="grid-template-columns:1fr 1fr"><div class="field"><label>LAST SUBMITTED BEFORE RESET</label><input name="preSubmitted" type="number" min="0" step="1" placeholder="e.g. 412"></div><div class="field"><label>LAST WITH ERRORS BEFORE RESET</label><input name="preErrors" type="number" min="0" step="1" placeholder="e.g. 120"></div></div>`
    : '';

  openModal('End shift · ' + (s.accountName || ''),
    `<p class="muted" style="margin-top:0">Started ${esc(fmtTime(s.startedAt))} · baseline <b>${num(base.submitted).toLocaleString()}</b> submitted · <b>${num(base.errors).toLocaleString()}</b> with errors</p>
     <ol class="muted" style="margin:0 0 12px;padding-left:18px;line-height:1.55"><li>Open the Abukai <b>Processing Stats</b> page again.</li><li>Select all (Ctrl+A) and copy (Ctrl+C).</li><li>Paste it below.</li></ol>${PASTE_FIELD}${resetFields}`,
    async fd => {
      const raw = String(fd.get('stats') || '');
      const en = parseAbukaiStats(raw);
      if (!en) { toast('Could not read the Abukai stats. Copy the whole Processing Stats page and paste again.'); return false; }
      if (!inWindow(sc)) { toast('Your scheduled shift has already ended.'); return false; }

      const ps = String(fd.get('preSubmitted') ?? '').trim(), pe = String(fd.get('preErrors') ?? '').trim();
      let pre = null;
      if (ps !== '' || pe !== '') {
        if (ps === '' || pe === '') { toast('Fill in both "before reset" numbers, or leave both empty.'); return false; }
        pre = { submitted: parseInt(ps, 10), errors: parseInt(pe, 10) };
      }
      const nowMs = Date.now();
      const r = computeShiftParts({ base, en, startMs, nowMs, pre });
      if (r.error) { toast(r.error); return false; }

      const useful = r.parts.filter(p => p.count > 0 || p.errs > 0);
      const send = useful.length ? useful : [r.parts[r.parts.length - 1]];
      const totalC = send.reduce((n, p) => n + p.count, 0), totalE = send.reduce((n, p) => n + p.errs, 0);
      const detail = send.length > 1 ? ` (${send.map(p => `${p.count.toLocaleString()} in ${monthLabel(p.month)}`).join(' + ')})` : '';
      const warn = totalC === 0 ? ' Your output is 0, are you sure?' : '';
      if (!await confirmBox('End shift and submit?', `Output: ${totalC.toLocaleString()} receipts, ${totalE.toLocaleString()} with errors${detail}. ${r.note ? r.note + ' ' : ''}This will be sent for admin review.${warn}`, 'Yes, submit', totalC === 0)) return false;

      const rateCents = rate(), pct = dedPct();
      const mk = p => {
        const gross = Math.round(p.count * rateCents), ded = Math.round(gross * pct / 100);
        return {
          workerId: currentUser.uid, workerName: profile.displayName, workerEmail: currentUser.email,
          accountId: s.accountId || s.id, accountName: s.accountName || '',
          shiftDate: s.shiftDate, shiftType: s.shiftType || 'Open shift', startTime: hhmm(new Date(p.from)), endTime: hhmm(new Date(p.to)),
          receiptCount: p.count, errorCount: p.errs, errorNote: p.part === 'after-reset' ? r.note : '',
          status: 'pending', rejectionReason: '',
          rateCents, deductionPercent: pct,
          grossCents: gross, deductionCents: ded, netCents: gross - ded,
          source: 'abukai-paste', abkMonth: p.month, ...(p.part ? { resetPart: p.part } : {}),
          startStats: p.s0, endStats: p.s1, startedAtMs: p.from, endedAtMs: p.to,
          startRaw: String(s.startRaw || '').slice(0, 2000), endRaw: raw.slice(0, 2000)
        };
      };

      if (!configured) {
        send.forEach((p, i) => data.submissions.unshift({ ...mk(p), id: 'local-' + Date.now() + '-' + i, createdAt: new Date(), updatedAt: new Date() }));
        data.activeShifts = data.activeShifts.filter(x => x.id !== s.id);
        toast('Demo shift submitted (not saved online).');
        renderPage();
        return;
      }
      try {
        const b = fb.writeBatch(db);
        send.forEach(p => b.set(fb.doc(fb.collection(db, 'submissions')), { ...mk(p), createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp() }));
        b.delete(fb.doc(db, 'activeShifts', s.id));
        await b.commit();
        const rt = errRatePct(totalC, totalE);
        toast(totalE > 0 && errWarnPct() > 0 && rt >= errWarnPct() ? `Shift submitted. ⚠ Your error rate for this shift is ${rt.toFixed(1)}% (limit ${errWarnPct()}%). Please double-check your work.` : 'Shift submitted for review.');
      } catch (e) {
        console.error(e);
        toast('Could not submit the shift. Check your connection and Firestore rules (submissions / activeShifts).');
        return false;
      }
    }, 'End shift & submit');
  liveStatsPreview('#trkPreview', base, crossed);
}
```

Unsay mahitabo karon sa **End shift**:
- **Wala nag-cross sa reset:** parehas ra gihapon (end minus start).
- **Nag-cross sa reset:** mogawas ang duha ka dugang nga field (**Last submitted before reset** ug **Last with errors before reset**).
  - Kung ma-fill-up pareho: ma-save og **2 ka record**, usa para sa bulan sa wala pa ang reset ug usa para sa bag-ong bulan (`abkMonth`, `resetPart`).
  - Kung walay butang: ang parte lang **human sa reset** ang ma-submit, ug naay note para sa admin nga mo-**Edit counts** kung gikinahanglan.
- Naay dugang nga check: dili puyde nga mas daghan ang errors kaysa receipts sa usa ka shift.

---
### Lakang 5: Warning sa tracker sa dili pa ang reset
Sa function nga `trackerPanel`, hanapa kini:

```js
<div id="shiftGate" data-ok="${inWin}">${shiftNoticeHtml(sc, inWin)}</div>${warn}${rows}</div>
```

ug ilisi ngadto sa:

```js
<div id="shiftGate" data-ok="${inWin}">${shiftNoticeHtml(sc, inWin)}</div>${resetNoticeHtml()}${warn}${rows}</div>
```

(Mogawas ang warning sulod sa 2 ka oras sa dili pa ang 8:00 AM reset: "Best: press End shift before then and Start shift again after".)

---
### Lakang 6: I-publish ang bag-ong `firestore.rules`
Naay bag-ong fields sa submission (`abkMonth`, `resetPart`, `startStats`, `endStats`, ug uban pa) ug naay rule para sa `activeShifts`. I-paste ang **tibuok** `firestore.rules` nga gihatag, dayon **Publish**. Pagkahuman: Ctrl+F5.

## Pagsulay
1. Pag-Start shift sa 7:50 AM (1st), pag-End shift sa 8:10 AM. Dapat mogawas ang duha ka "before reset" nga field.
2. Sa 7:59 AM sa 1st ang dashboard kay October pa gihapon; sa 8:00 AM mahimong November (This month = 0).
