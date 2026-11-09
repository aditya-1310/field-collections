# Fieldnote technical design

[https://github.com/aditya-1310/field-collections](https://github.com/aditya-1310/field-collections)

[Live demo](https://fieldnote-collections.onrender.com/) · Verified release `fdb9e90`

Fieldnote gives a field officer a short list of overdue cases and records the results of calls and visits. A branch manager can import the daily report, assign cases, resolve conflicting promises, and see which loans moved into a later overdue group. The demo uses synthetic records, including the three loan examples from the assignment.

## Architecture and rationale

| Layer | Decision | Why |
| --- | --- | --- |
| Browser | React, TypeScript, Vite and Tailwind | One responsive interface works on a manager's desktop and an officer's phone. |
| Offline storage | Service worker and IndexedDB | The app shell and the officer's downloaded work remain usable with weak connectivity. Stable outbox IDs make retries safe. |
| Application | Express and TypeScript | The API and compiled UI can run on one origin. Cookie sessions and branch access stay on the server. |
| Database | PostgreSQL on Neon | Loans, promises, assignments, and activity have clear relationships. SQL transactions keep related updates together. |
| Local runtime | Embedded PostgreSQL through PGlite | Reviewers can run the same schema without Docker or a hosted database account. |
| Deployment | Render Node Web Service | One service builds and serves the app. The PostgreSQL URL is supplied as an environment secret. |

## Data model

| Records | Relationships and invariants |
| --- | --- |
| Branches, users and sessions | One branch per user. Field officers and branch managers share an account table. The server stores password hashes and session-token hashes. |
| Borrowers, loans and assignments | One borrower can have many loans. Each loan belongs to a branch and has at most one current officer. The stable lender loan ID matches repeat imports. Assignment changes append an audit entry. |
| Import batches and daily loan history | One batch tracks each accepted or rejected report. A loan can have one reported position per date. The report date and upload time serve different purposes. |
| Officer activities and promises | An activity records what happened, when, who recorded it, and GPS if available. A promise records amount, due date and revision. A partial unique index protects one active promise per loan. |
| Sync events and promise conflicts | A client-generated event ID uniquely identifies an upload. A conflict references that original payload and the server promise observed at detection. |
| Mock payments and contact attempts | Mock payment references prevent duplicate balance deductions. Contact attempts retain allow/block decisions and share a daily borrower contact allowance. |
| Queue runs, scores and overrides | A saved run captures the officer's eligible population and each loan's base rank. Manual orders preserve the base scores and record the manager's reason. Frozen weekly members reference the saved score. |

## Main workflows

### Daily import and assignment

The manager selects a CSV and its report date. The server validates the whole file, checks branch and borrower identity, and records the outcome. Accepted writes update the current loan position and append daily history in a transaction. Existing assignments and promises remain attached to the same loan. New cases go to an active officer who covers the pincode, using the current workload to break ties. The manager can move a case explicitly. A missing row leaves the last report date visible, so the app does not mistake silence for payment.

### Officer outcome and offline sync

The officer opens a case, chooses the outcome, and saves it. A promise additionally requires the amount and date. A visit can include GPS when the phone grants access. The client writes the event to IndexedDB before attempting upload. Opening the app, returning focus, or reconnecting can trigger sync. The browser acknowledges the outcome only when the server returns a stored receipt. A repeated submission reuses the event ID.

If the active promise changed since the officer's cached revision, the server saves the incoming event and a review ticket together. The current promise remains active while the manager compares both proposals. The resolution checks the live revision again and records the manager's decision. This prevents an old phone copy from silently overwriting a newer promise.

### Contact, reminders and payment confirmation

The server checks the current assignment, report freshness, case status, and India contact window on each mock contact request. The allowed window begins at 08:00 and ends at 19:00. A borrower-level daily guard coordinates several loans for the same borrower. Every allowed or blocked request is audited. Hindi and English reminder drafts use approved wording, and the officer approves the exact draft before simulating a send.

An officer's Paid outcome is a report awaiting confirmation. The manager can simulate a confirmed external payment with a reference. A partial payment reduces arrears and retains DPD. Full arrears settlement clears the overdue position. There is no cash collection or payment gateway.

## Priority automation

The first question is whether action is due. Future promises stay scheduled. Stale reports, open disputes, and conflicting updates remain visible for review. Among actionable loans, older unfinished follow-up dates come first. Within an equally due group, the queue alternates 1–30 DPD cases with 31+ DPD recovery cases, starting with Early on a new day. This gives both prevention and recovery work a turn.

Inside each group, compare DPD, an unresolved broken promise, the previous three installments where comparable history exists, and overdue amount. Loan reference provides stable order for an exact tie. The priority score is derived from rank and queue length. A five-case queue scores 100, 80, 60, 40 and 20. The explanations come from observed facts. A high score identifies a position in one officer's queue. It does not estimate default probability or authorize contact.

The equal turn allocation and three-installment lookback are disclosed policy choices. We chose them because the brief supplies a business objective and sample records, without a labeled dataset to establish predictive weights. The manager can override a visible order with a reason. The base result stays available for review.

## Reporting and interface

The manager's roll-rate view follows the same loans from observed 1–30 DPD at the start to observed 31–60 DPD at the end. The displayed rate uses known endpoints and shows coverage. Missing endpoints remain unknown. The separate weekly score review freezes queue positions and summarizes subsequent confirmed mock payments by position group. The completed demo week is labeled synthetic. Late confirmations produce a new completed report revision and retain the previous one.

The officer view emphasizes the next case, DPD, reasons, and a large action button. Hindi and English labels support the field workflow. The manager's wider workspace separates the branch overview, imports, assignments, and review. Status labels distinguish scheduled work, pending sync, review, and handled cases. Offline caches are bound to the account, while protected API requests use the live session.

## Tradeoffs and next steps

The demo uses fixed approved reminder templates and assumes a complete mock ledger. Weekly baselines are captured on demand from eligible runs saved before the cutoff. The report shows incomplete coverage when no valid run exists. Run history retention is specified in the design, and automated cleanup remains future work. Production operation would require integration with the lender's daily reports and payment confirmations, including evidence of source coverage. The current contact window comes from the assignment. Actual operational compliance requires separate validation and monitoring.

The first rollout should track report freshness, completion and sync delays, and resolution time. Compare alternative queue rules on real outcomes with consistent observation windows before claiming a roll-rate improvement. Add durable notification delivery, review richer history where it is available, and validate field workflows with officers using low-end phones.

## Verification

The release passed the production build and 23 automated tests. Eight local browser checks covered manager and officer sign-in, report visibility, CSV upload, mobile layout, offline reload with a GPS visit, reconnect sync, and a 51-event outbox. Five hosted browser checks verified both roles, the weekly report, manager action restrictions, and an account switch with an earlier request still in flight. The public health endpoint verified the Neon connection. Field performance and collection outcomes require a pilot.

The implementation record in the repository connects these decisions to the SQL schema, API modules, browser outbox, tests, and deployment instructions. [Implementation decisions](https://github.com/aditya-1310/field-collections/blob/main/docs/decisions.md)
