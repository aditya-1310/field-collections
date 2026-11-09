# Run and deploy Fieldnote

[GitHub repository](https://github.com/aditya-1310/field-collections)

[Live Fieldnote demo](https://fieldnote-collections.onrender.com/)

The verified application release is commit `fdb9e90` on Render's free Singapore service, with the Neon database in Singapore. The live [database-backed health check](https://fieldnote-collections.onrender.com/api/health) returns HTTP 200.

## Run locally

1. Clone the repository and open its folder.
2. Use Node.js 22.12 or newer and install packages with `npm ci`.
3. Copy `.env.example` to `.env`. Leave `DATABASE_URL` empty for embedded PostgreSQL. The local database is stored under `.data/postgres`.
4. Run `npm run dev`. Open the Vite URL shown in the terminal, usually `http://localhost:5173`.
5. The server creates the schema and seeds the synthetic dataset on the first local run.

| Role | Email | Demo password |
| --- | --- | --- |
| Branch manager | `manager@fieldnote.demo` | `Demo@12345` |
| Field officer | `officer@fieldnote.demo` | `Demo@12345` |

To exercise CSV assignment, sign in as the manager and upload `fixtures/overdue-loans.csv` using today's India report date. A newly seeded dataset is already dated for the day it was created. On later dates, older cases remain visible and need fresh reports before they appear in Work today.

## Deploy on Render with Neon

1. Create a Neon PostgreSQL project and copy its connection string from the Connect dialog.
2. Create a Render Node Web Service for this repository's `main` branch.
3. Set the build command to `npm ci --include=dev && npm run build` and the start command to `npm start`.
4. Set `DATABASE_URL` to the Neon URL in the service's environment settings. Set `NODE_ENV=production` and `SEED_DEMO=true` for the dedicated synthetic demo database. Render supplies `PORT`.
5. Set the health-check path to `/api/health`. Deploy, check the health endpoint, and try both demo roles.

| Environment setting | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. Required in production. Keep it in hosting secrets. |
| `DATABASE_PATH` | Optional local embedded PostgreSQL path. Defaults to `.data/postgres`. |
| `PORT` | Express port. Defaults to `3001` locally. |
| `NODE_ENV` | Set to `production` on Render for the deployed cookie and server settings. |
| `SEED_DEMO` | Set to `true` on an empty, dedicated demo database to create synthetic accounts and cases. |

The first server start applies `server/schema.sql` before listening. The seed runs in a transaction and skips an already populated user database. Render's free web service can take time to wake after inactivity. Neon connection details and hosting commands are documented by the providers. See the [Neon connection guide](https://neon.com/docs/get-started/connect-neon), [Render web services](https://render.com/docs/web-services), and [Render free instance limits](https://render.com/docs/free).

## Verify the main workflow

Run `npm test` and `npm run build`. Use `npm start` to test the built app at `http://localhost:3001`. The service worker is enabled in the build. Open the app online, then disconnect the browser, save a visit outcome, reconnect and check its sync status. Log back in as manager to view the resulting activity or conflict. Contact attempts before 08:00 or at and after 19:00 India time are blocked and audited once they pass input, session, and loan-access checks. Payments and messages in the demo are simulated.
