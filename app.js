You are a senior front-end developer. I am attaching my website's app.js (Steivy Receipt Hub: vanilla JS ES module, Firebase Auth + Firestore, roles: admin and worker). Implement ALL the features below in one pass. Keep the existing code style, existing helpers (esc, toast, openModal, money, monthKeyOf, monthLabel, requestRender, listen, etc.) and the demo-mode behavior (when `configured` is false, everything must still work locally using data.submissions / data.accounts / data.users). Do not change unrelated features. All UI text must be professional English.

Return the FULL updated app.js in a single code block, ready to copy and paste, with no "rest of code here" placeholders. After the code give the Firestore rules snippet and a short bullet list of what changed.

=====================================================
1) ADMIN > ACCOUNTS TAB: Edit and Delete account
=====================================================
- Add "Edit" and "Delete" buttons to every account row (admin only), next to the existing Assign workers / Activate / Deactivate buttons. Wire them in the existing delegated click handler (data-edit-account, data-delete-account).
- Build a reusable Promise-based `confirmDialog({ title, message, confirmLabel, danger })` that returns true/false. It must stack above other modals (z-index higher than the edit modal), close on Cancel, backdrop click and Escape (update the global Escape handler so it closes the confirm dialog first), and must not break the existing openModal. Escape all text with esc().
- Edit account: opens a modal with name, code, notes (prefilled). Validate: name required; account code must remain unique (exclude the account itself). On submit, show the confirmation pop-up: title "Save changes?", message "Are you sure you want to update the account "<name>"?", buttons Cancel / "Yes, save changes". If the user cancels, keep the edit modal open.
- Editing the name must also update `accountName` on that account's existing submissions (Firestore writeBatch together with the account update, max 450 submission docs per batch).
- Delete account: confirmation pop-up (danger style): title "Delete account?", message "Are you sure you want to delete "<name>"? N assigned worker(s) will lose access to it. Its N existing submission(s) will be kept. This action cannot be undone.", buttons Cancel / "Yes, delete account". On confirm, in ONE writeBatch: delete the account doc and arrayRemove the account id from `assignedAccountIds` of every user that has it. Do NOT delete submissions.
- Must also work in demo mode.

=====================================================
2) DASHBOARD (BOTH ADMIN AND WORKER): Team chat ticker box
=====================================================
- Add a panel right below the "Online now" strip showing team chat messages from `data.messages` (last 15) sliding upward continuously in a loop, in random (shuffled) order. Each row shows sender name + message (single line, ellipsis).
- Make the loop seamless (duplicate the set in the track and translateY to -50%; repeat items if fewer than 4 messages). Pause on hover. Respect prefers-reduced-motion. Show an empty state when there are no messages.
- Clicking the box opens the Team chat page (use the existing data-page="chat" navigation), where all messages are visible.
- When a new message arrives, update ONLY this box (no full dashboard re-render, so typing elsewhere is not interrupted): in requestRender('chat'), if page === 'dashboard' call updateChatTicker(). Keep the same shuffled order until a new message arrives (cache by message count + last message id).
- Visible to every signed-in user (admin and worker).

=====================================================
3) LEADERBOARD: AUTOMATIC, REAL-TIME, NO ADMIN APPROVAL
=====================================================
GOAL
The dashboard must count automatically and in real time, with NO admin approval and NO admin needing to be online.
- Count every submission of the current month (by shiftDate, YYYY-MM) whose status is "pending" or "approved". Exclude only "rejected". Sum receiptCount (processed output) and errorCount per worker.

ADMIN DASHBOARD
- Show two panels (using the existing grid-2 layout), computed live from all submissions:
  a) "🏆 Top output": top 3 workers by processed receipts this month (only receipts > 0).
  b) "⚠️ Most errors": top 3 workers by error count this month (only errors > 0).
- Each row: rank (icon for #1, number for others), avatar initials, worker name, count (errors in red). Show the month label (monthLabel) in the subtitle. Show empty states when there is no data.

WORKER DASHBOARD (banners shown above the stats, only for the logged-in worker)
- The worker with the HIGHEST processed receipts this month (receipts > 0, ties allowed) sees a green banner:
  "Congratulations, <first name>! You have the highest output of all workers this month with N processed receipts. Excellent work, keep it up!"
- The worker with the HIGHEST error count this month (errors > 0, ties allowed) sees a yellow banner:
  "Please be more careful, <first name>. You have the most errors of all workers this month (N). Take a little extra time to double-check each receipt before submitting."
- A worker can see both banners if both apply. Workers with low output must NOT get the congratulations banner, and workers who are not the top in errors must NOT get the warning banner. If neither applies, show nothing.

HOW (required, because workers can only read their own submissions and I do not want to loosen that)
1. Create one Firestore doc per month: `leaderboards/{YYYY-MM}` with shape:
   { month: "YYYY-MM", workers: { "<uid>": { name, receipts, errors } }, updatedAt }
2. Every signed-in user runs `scheduleStatsSync()` (debounced ~1s) whenever their `submissions` snapshot changes (hook it inside listen() when key === 'submissions').
   - Worker: compute ONLY their own totals for the current month from their own submissions (exclude rejected) and write ABSOLUTE values (not increments) with setDoc(..., { merge: true }) containing only `workers.<ownUid>`. If the worker has no submissions this month, skip the write unless an entry already exists (then write zeros).
   - Admin: compute all workers from data.submissions and write all entries (this repairs entries after the admin edits counts).
   - Skip the write when values are unchanged since the last write (keep a signature string) to avoid loops and extra cost. Never trigger a sync from the leaderboards listener. Catch errors and console.warn with a hint to check Firestore rules for /leaderboards.
3. All users listen with onSnapshot to the whole `leaderboards` collection and store it in `data.leaderboards` keyed by doc id (add `leaderboards: {}` to the data object and reset it in loadData). Select the current month's doc at render time with monthKeyOf(0), so the month rolls over automatically without a page reload. Re-render with requestRender() when it changes.
4. `computeLeaderboard(rows = data.submissions)` returns { month, workers: [{ id, name, receipts, errors }] } for the current month (exclude rejected), sorted by id for a stable signature.
5. `leaderboardWorkers()`:
   - Admin or demo mode (`!configured`): computeLeaderboard().workers (always live).
   - Worker: take data.leaderboards[monthKeyOf(0)]?.workers (map -> array with id), then OVERRIDE the worker's own entry with locally computed values, so their own numbers update instantly before the Firestore round trip.
6. `performersPanel()` (admin) and `workerBanner()` (worker) use leaderboardWorkers(). In dashboard(), insert them right after `${monthStats(rows)}`: `${isAdmin() ? performersPanel() : workerBanner()}`.

=====================================================
4) STYLES
=====================================================
Add a second injected <style> block (like the existing extraStyle) for: .chat-ticker, .tick-box (fixed height ~156px, overflow hidden, soft fade mask), .tick-track (infinite keyframes translateY(0) -> translateY(-50%)), .tick-item (fixed height ~52px), .perf-row, .perf-rank, .perf-banner.good (green), .perf-banner.warn (yellow). Reuse existing CSS variables and classes where possible.

=====================================================
5) FIRESTORE RULES (give me exactly these)
=====================================================
Assume my existing isAdmin() helper (adapt if it is named differently). Provide:

match /accounts/{id} {
  allow delete: if isAdmin();
}

match /leaderboards/{month} {
  allow read: if request.auth != null;
  allow create: if request.auth != null
    && (isAdmin() || request.resource.data.workers.keys().hasOnly([request.auth.uid]));
  allow update: if request.auth != null
    && (isAdmin() || request.resource.data.workers.diff(resource.data.workers).affectedKeys().hasOnly([request.auth.uid]));
}

Also remind me that admin must be allowed to update `submissions` (accountName sync) and `users` (assignedAccountIds cleanup) in my existing rules.

=====================================================
OUTPUT FORMAT
=====================================================
1. The complete updated app.js in ONE code block.
2. The Firestore rules snippet.
3. A short bullet list of what changed and any limitations.
