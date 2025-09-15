# Purchase Tracker (Prototype)

Mobile-first Node.js prototype to track spontaneous purchases within a monthly budget cycle. No persistence yet (in-memory only).

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
- `/` shows remaining budget for the current cycle. Amount is masked as `***` until tapped.
- `/spend` add a purchase with amount, date (defaults to today), and optional description.

## Notes
- Data is stored in-memory for this prototype. Restarting the server clears purchases.
