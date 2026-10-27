# Steivy Receipt Hub — Browser edition

This is a new static web client for the Android project. It recreates the key flows as a responsive browser UI: email/password sign-in, worker and admin dashboards, shift submissions, submission review, account list/create, earnings reports with CSV export, team group chat, worker listing, and pay settings.

## Important project notes

- The Android project is Kotlin + Jetpack Compose. Android screens cannot run directly in a browser, so `web/` is a separate web implementation using HTML/CSS/JavaScript and the Firebase Web SDK.
- `web/firebase-config.js` intentionally contains placeholders. The uploaded Android source does not include a Firebase Web App config, and there are no web API credentials to reuse. You must add the Web App config from your Firebase Console.
- Demo worker/admin buttons only show sample data in your browser. Demo changes are not saved and do not authenticate with Firebase.
- The client expects the existing Firestore collections used by the Android app: `users`, `accounts`, `submissions`, `settings/paySettings`, and `conversations/company_group/messages`.
- The browser client cannot bypass Firestore Security Rules. Test every operation with your real rules and signed-in roles. Do not make the database public to “fix” permission errors.
- This is a first web port of the main workflows, not a pixel-perfect or feature-for-feature Kotlin port. In particular, detailed account assignment flows, private/direct chat conversations, full audit history, and some Android-specific validation/workflows still need further implementation.

## 1. Configure Firebase

1. Open the Firebase project used by the Android app.
2. In **Project settings → General → Your apps**, register a **Web app** if there is not already one.
3. Copy the Firebase Web App configuration object.
4. Edit `web/firebase-config.js` and replace every `YOUR_...` placeholder with the actual values.
5. In Firebase Authentication, enable **Email/Password**. Create/test accounts as needed.
6. Confirm Firestore is the database used by your Android app and deploy/review the appropriate Firestore rules. The website uses the same collection names as the Android source.
7. Confirm user profile documents in `users/{authUid}` have the fields the Android app expects, especially `displayName`, `role` (`admin` or `worker`), `isActive`, `status`, and `assignedAccountIds`.

**Never put service-account JSON, Admin SDK private keys, or other server secrets in this static website.** Firebase Web API config is designed for client apps, but access must still be protected by Authentication and Firestore Security Rules.

## 2. Test locally

Because ES modules and Firebase imports require an HTTP origin, don't open `index.html` directly as a `file://` URL. From the `web/` directory, run one of:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000` in your browser. Without Firebase config, the demo preview buttons let you explore the UI. With valid config, test with actual worker and admin accounts.

## 3. Publish free on GitHub Pages

This repository includes `.github/workflows/deploy-web.yml`, which publishes the contents of `web/` to GitHub Pages.

1. Create a GitHub repository and upload/push the project files, including `.github/workflows/deploy-web.yml` and `web/`.
2. In the GitHub repository, open **Settings → Pages**.
3. Under **Build and deployment → Source**, select **GitHub Actions**.
4. Push to the `main` branch (or run the workflow manually from **Actions**). Wait for the “Deploy Steivy web app to GitHub Pages” workflow to finish.
5. GitHub will show the published site URL in **Settings → Pages**. Open it on your phone or computer.

GitHub Pages hosts only static files. Firebase Authentication and Firestore are separate services with their own quotas and terms. For GitHub Pages hosting, use Firebase Authentication's supported sign-in flow and ensure your published domain is permitted in **Authentication → Settings → Authorized domains**. Add the GitHub Pages hostname if it isn't already listed.

## 4. Before real use

- Test as a worker and as an admin separately.
- Verify that workers can only read their own submissions and assigned accounts, and that only admins can review submissions or modify pay settings.
- Review the existing `firestore.rules` carefully before deploying. Do not loosen rules to make the website work.
- Use test records first. This initial client creates submissions using the current gross rate and deduction percentage; changing pay settings does not recalculate historical records.
- If a page says a read/write failed, inspect the browser console and Firestore rules. A successful sign-in alone does not mean Firestore permissions are correct.
