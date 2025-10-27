# Purchase Tracker

Mobile-first Node.js app to track spontaneous purchases within a monthly budget cycle. Uses Firebase Admin for persistence.

## Configure

Edit `config.js`:
- `budgetStartDay`: day of month the cycle starts (1-28 recommended)
- `monthlyBudget`: integer monthly amount
- `currencyCode`: ISO 4217 code (e.g., USD, EUR)

## Run

```bash
npm install
npm run dev
# open http://localhost:3000
```

## Pages
- `/` dashboard with remaining budget and weekly breakdown
- `/details` weekly details
- `/spend` add a purchase
- `/settings` change budget, currency, language; manage public link

## Auth

Auth supports a magic-link (email link) flow fully handled on the server for regions where Google CDNs/APIs are blocked.

When `MAGIC_LINKS_ENABLED=true`:

- Login page shows an email-only form.
- POST `/auth/email-link/start` generates a Firebase Email Link on the server and renders a page with the link you can copy or open.
- GET `/auth/email-link/callback?oobCode=...&email=...` finalizes sign-in on the server (no client SDK), creates a Firebase Session Cookie, and redirects home.

Environment variables:

- `MAGIC_LINKS_ENABLED=true`
- `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` (for Admin SDK)
- `FIREBASE_WEB_API_KEY` (Web API key for calling identitytoolkit from the server)
- `BASE_URL=https://your-domain.example` (used in links and email templates)
- Optional Resend (to send emails from your domain):
  - `RESEND_API_KEY=...`
  - `RESEND_FROM=Your App <no-reply@yourdomain.example>`

Notes:

- The app does not use the Firestore client web SDK; all reads/writes are via Admin SDK on the server and rendered with EJS.
