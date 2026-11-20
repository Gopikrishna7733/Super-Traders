# Super Traders

## Secure Firebase setup

The admin page and game writes require the Firebase backend in this project. A client-side passcode is not used.

1. In Firebase Console, create the Firestore database; enable **Authentication → Email/Password**; create the admin account and verify its email.
2. Enable billing for the Firebase project if required by Cloud Functions, then install the Firebase CLI and authenticate it for the project selected in `.firebaserc`.
3. Use Node.js 22, then from the project folder run `npm install --prefix functions`.
4. Deploy the API and Firestore rules with `firebase deploy --only functions,firestore:rules`. When prompted for `ADMIN_EMAIL`, enter the verified admin account email. Do not commit credentials or environment files.
5. Host the web pages on an authorized Firebase Auth domain. Sign in at `admin.html`.

The `claimAdmin` function only grants the admin claim to the verified email configured as `ADMIN_EMAIL`. The admin document, which contains the current answer key, is readable only with that claim. All Firestore writes go through the callable API; unauthenticated clients can only request a validated bid. The rules must be deployed before relying on these protections.
