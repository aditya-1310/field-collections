# Implementation decisions

This record explains the code and the tradeoffs behind it. The earlier [priority policy](./priority-policy-final.md) preserves the full design discussion. The repository's routes and tests are the reference for implemented behavior.

## One app with a PostgreSQL database

React handles the officer and manager screens. Express serves the built UI and the JSON API from one origin in deployment. This simplifies cookie sessions and avoids a separate frontend deployment. Neon runs PostgreSQL for the hosted app. Local development can run the same schema in embedded PostgreSQL through PGlite, and API tests use its in-memory mode. The SQL schema and parameterized queries stay shared between both paths.

Code: `server/db.ts`, `server/schema.sql`, `server/index.ts`, `vite.config.ts`.

## Identity and access

Each user belongs to one branch and has either the field-officer or branch-manager role. The server looks up the session and user on protected requests. Passwords use bcrypt hashes and session tokens are stored as hashes. Branch managers work within their branch. Officers can read or act on loans assigned to them. Public demo accounts use a dedicated synthetic database.

Code: `server/routes.ts`, `server/portfolio.ts`, `server/schema.sql`.

## Daily import and ownership

The report date describes the source figures. The upload timestamp records when they arrived. Validate the entire CSV before applying changes. Match existing loans using the lender reference, preserve their officer and related promises, and append accepted daily positions for roll-rate reporting. A loan missing from a file retains its existing record and freshness date. For a new case, restrict eligible officers to the branch and pincode, then choose the least loaded. A manager can reassign explicitly with an audit reason.

The seed preserves the three sample loan IDs, DPD values, outstanding balances, and officer names from the brief. The overdue amounts, contact details, prior payment counts, historical outcomes, and additional cases are synthetic demo extensions.

Code: `server/imports.ts`, `server/seed.ts`, `fixtures/overdue-loans.csv`.

## Priority and reasons

Check eligibility before ordering. Future promises stay scheduled, and stale or disputed cases stay visible with their status. Oldest actionable follow-up dates come first. Within an equally due group, alternate 1–30 DPD and 31+ DPD work. Within either group, order by DPD, unresolved broken promise, comparable prior installment history, overdue amount, and stable loan reference. Skip history for a tied group if any member lacks a comparable three-installment record.

The queue score derives from position. For five eligible cases the scores are 100, 80, 60, 40, and 20. The same base score is shown to the officer and manager. The reason list is built from the facts used in the policy. Manager reordering preserves the base score. The chosen approach is deterministic automation approved for this project. The equal alternation and three-installment window are explicit policy choices.

Code: `server/policy.ts`, `server/portfolio.ts`, `server/policy.test.ts`.

## Offline outcomes and promise conflicts

The service worker caches the app shell. IndexedDB holds the signed-in user's downloaded cases and pending updates. Each saved outcome gets a stable event ID. The browser retries when the app opens, regains focus, or reconnects. The server recognizes duplicate IDs and sends a receipt after committing the transaction. Pending updates remain local until the server acknowledges them. Geolocation is attached when available.

Promise changes carry the identity and revision seen on the device. If the active promise changed while the device was offline, persist the event and a manager-review ticket. The existing promise stays active until resolution. Both inputs and the manager's decision remain auditable. The server rechecks the promise revision when the manager resolves the ticket.

Code: `src/offline.ts`, `public/sw.js`, `server/operations.ts`.

## Contact and payment boundaries

Use the server's India time for the 08:00 inclusive to 19:00 exclusive contact window. Audit allowed and blocked contact requests. The mock contact allowance is per borrower per day, even across several loans. An accepted mock attempt consumes the allowance, and an identical retry reuses the result. A bilingual reminder uses fixed approved wording and a separate officer send action. Officer-reported payment waits for an external mock confirmation. Partial confirmed payment reduces arrears and preserves DPD. Full arrears settlement clears the overdue position.

Code: `server/operations.ts`, `server/routes.ts`, `server/policy.ts`.

## Reports and limitations

Branch roll rates compare observed daily DPD positions for the same loans. Missing endpoint records are reported as unknown. The weekly score review uses a frozen historical queue and compares it with later confirmed mock payments. The initial completed week is visibly synthetic. The mock payment ledger is treated as complete in the demo. Production use would need a reliable payment-feed coverage marker, live historical evaluation, operational monitoring, and a real data-retention policy.

Code: `server/portfolio.ts`, `server/routes.ts`, `server/seed.ts`.
