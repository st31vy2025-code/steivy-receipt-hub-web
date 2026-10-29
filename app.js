You are a senior front-end developer. I am attaching my website's app.js (Steivy Receipt Hub: vanilla JS ES module, Firebase Auth + Firestore, roles: admin and worker). I previously added a monthly leaderboard (computeLeaderboard, scheduleLeaderboardSync, leaderboardWorkers, workerBanner, performersPanel, data.leaderboard, the `stats/leaderboard` doc). REPLACE that leaderboard mechanism with the one below. Keep everything else unchanged, keep the existing code style and demo mode (when `configured` is false, compute locally from data.submissions). Return the FULL updated app.js, ready to copy and paste. All UI text in professional English.

GOAL
The dashboard must count automatically and in real time, with NO admin approval and NO admin needing to be online.
- Count every submission of the current month (by shiftDate) whose status is "pending" or "approved". Exclude only "rejected".
- Worker dashboard banners:
  a) The worker with the HIGHEST processed receipts this month (receipts > 0, ties allowed) sees a green banner: "Congratulations, <first name>! You have the highest output of all workers this month with N processed receipts. Excellent work, keep it up!"
  b) The worker with the HIGHEST error count this month (errors > 0, ties allowed) sees a yellow banner: "Please be more careful, <first name>. You have the most errors of all workers this month (N). Take a little extra time to double-check each receipt before submitting."
  c) A worker can see both banners if both apply. Workers with low output must NOT get the congratulations banner, and workers who are not top in errors must NOT get the warning banner. If neither applies, show nothing.
- Admin dashboard keeps the "Top output" and "Most errors" top-3 panels, computed live from all submissions.

HOW (must follow, because workers can only read their own submissions)
1. Create one Firestore doc per month: `leaderboards/{YYYY-MM}` with shape:
   { month: "YYYY-MM", workers: { "<uid>": { name, receipts, errors } }, updatedAt }
2. Every signed-in user runs `scheduleStatsSync()` (debounced ~1s) whenever their `submissions` snapshot changes (hook it inside listen() when key === 'submissions').
   - Worker: compute ONLY their own totals for the current month from their own submissions (exclude rejected) and write absolute values (not increments) using setDoc(..., { merge: true }) with only `workers.<ownUid>` populated. If the worker has no submissions this month, skip the write unless an entry already exists (then write zeros).
   - Admin: compute all workers from data.submissions and write all entries (this repairs entries after the admin edits counts).
   - Skip the write if the values are unchanged since the last write (keep a signature string) to avoid loops/extra cost. Do not trigger a sync from the leaderboards listener.
3. All users listen with onSnapshot to the whole `leaderboards` collection and store it in `data.leaderboards` keyed by doc id. Pick the current month's doc at render time with monthKeyOf(0), so the month rolls over automatically without a page reload.
4. `leaderboardWorkers()`:
   - Admin or demo mode: computeLeaderboard() from data.submissions (always live).
   - Worker: take data.leaderboards[monthKeyOf(0)].workers (map -> array with id), then OVERRIDE the worker's own entry with the locally computed values so their own numbers update instantly, before the Firestore round trip.
5. workerBanner() and performersPanel() use leaderboardWorkers(). Re-render the dashboard when data.leaderboards changes (use requestRender()).

FIRESTORE RULES
Remove the old `stats` rules and give me exactly these (assuming my existing isAdmin() helper; adapt if it has a different name):

match /leaderboards/{month} {
  allow read: if request.auth != null;
  allow create: if request.auth != null
    && (isAdmin() || request.resource.data.workers.keys().hasOnly([request.auth.uid]));
  allow update: if request.auth != null
    && (isAdmin() || request.resource.data.workers.diff(resource.data.workers).affectedKeys().hasOnly([request.auth.uid]));
}

This way a worker can only write their own entry, and an admin can write any entry.

OUTPUT
- The complete updated app.js in one code block, no placeholders.
- Then the rules snippet.
- Then 3 bullet points listing what changed.
