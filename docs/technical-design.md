# Fieldnote technical design

[https://github.com/aditya-1310/field-collections](https://github.com/aditya-1310/field-collections)

[Live demo](https://fieldnote-collections.onrender.com/)

Verified application release `fdb9e90`.

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

The app runs as one application with separate modules for imports, collection activity, prioritization, and reports. Keeping the UI and API together reduces deployment setup and lets them share TypeScript types. PostgreSQL suits the relationships between loans, officers, promises, and payments. Transactions matter here because an offline submission and its result must either be saved together or rolled back together.

### Access and personal data

Access checks happen on the server. A manager can work within their branch, and an officer can act on their assigned cases. Sessions expire after 12 hours. The session cookie is HttpOnly, SameSite Strict, and Secure in production. Login attempts are rate limited, and write requests are checked for origin. Input validation and parameterized SQL protect the database boundary.

The service worker caches the interface, while IndexedDB stores cases and pending updates by account. API responses use no-store headers. The client also discards responses from an earlier sign-in so an account switch cannot replace the current user's list. The database connection string stays in hosting secrets. The demo contains synthetic borrower data. Browser storage is not separately encrypted, so production device access and retention need further work.

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

The manager selects a CSV and its report date. The server validates the whole file, checks branch and borrower identity, and records the outcome. Accepted writes update the current loan position and append daily history in a transaction. Existing assignments and promises remain attached to the same loan. New overdue cases go to an active officer who covers the pincode, using the current workload to break ties. A case stays unassigned when no matching officer is available. The manager can assign or move it explicitly. A missing row leaves the last report date visible, so the app does not mistake silence for payment.

An older report can add missing history, but it cannot replace newer current figures. A different financial position for a loan and report date already accepted is rejected. Uploading the same file for the same branch and date returns the earlier result. These rules keep repeated uploads from changing ownership or rewriting accepted history.

### Officer outcome and offline sync

The officer signs in online and downloads their cases before working offline. They open a case, choose the outcome, and save it. A promise also requires an amount and date. A visit can include GPS when the phone grants access. The client writes the event to IndexedDB first and shows it as pending sync. Opening the app, returning focus, or reconnecting triggers an upload attempt. A browser connection signal starts the attempt, but only the server's receipt confirms that the update arrived.

Each submission keeps the same event ID through retries. The server processes an event in a transaction and returns the existing receipt if that ID was already saved. The client uploads at most 50 events per request and keeps entries pending when it has no receipt. A temporary network failure can therefore be retried without recording the same visit twice.

An incoming promise update carries the promise ID and revision seen on the phone. If either differs from the current promise, the server saves the incoming event and a review ticket together. The existing promise is left unchanged while the manager compares both proposals. Before saving the decision, the server checks that the promise still matches the version the manager reviewed. Both the original submission and the decision stay in the audit history. This prevents an old phone copy from silently overwriting a newer promise.

### Contact, reminders and payment confirmation

The server checks the current assignment, report freshness, case status, and India contact window on each mock contact request. Contact is allowed from 08:00 inclusive until 19:00 exclusive, using Asia/Kolkata time on the server. A recorded contact or visit uses the borrower's daily contact allowance across all their loans. Further mock calls or messages are blocked for that day. Once a request passes input, session, and loan-access checks, its allowed or blocked decision is recorded. Invalid or unauthorized requests are rejected before that record is created.

Hindi and English reminders use fixed approved templates. A word filter checks the draft, and the officer approves the exact message before simulating a send. The server checks the draft again when Send is tapped, so approval of an older message cannot authorize a changed one.

An officer's Paid outcome is a report awaiting confirmation. The manager can simulate a confirmed external payment with a reference. A partial payment reduces arrears and retains DPD. Full arrears settlement clears the overdue position. There is no cash collection or payment gateway.

## Priority automation

The first question is whether action is due. DPD means days past due. Future promises stay scheduled. Stale reports, open disputes, and conflicting updates remain visible for review. Among actionable loans, older unfinished follow-up dates come first. Within an equally due group, the queue alternates cases at 1 to 30 DPD with recovery cases above 30 DPD, starting with Early on a new day. If one group is empty, the queue takes from the other. This gives both prevention and recovery work a turn.

Inside each group, higher DPD comes first. If DPD is equal, an unresolved broken promise takes precedence. If that is also equal, compare how many of the previous three installments were late, then use the higher overdue amount. If anyone in that tied group lacks comparable payment history, skip that comparison for the whole group. This avoids treating missing history as a good payment record. The lender's loan reference keeps the order stable when everything else is equal.

For rank `r` in a queue of `N` eligible cases, the score is `100 * (N - r + 1) / N`, rounded to two decimal places. A five-case queue scores 100, 80, 60, 40 and 20. The top three reasons describe the facts used by the policy. Each saved run stores the input facts, reasons, base rank, and policy version so the decision can be explained later. Both roles see the same base score. It describes position within one officer's queue, so scores from different officers are not directly comparable. It does not estimate default probability or authorize contact.

This version uses deterministic rules. The equal turn allocation and three-installment lookback are policy choices that need evaluation on real outcomes. The brief supplies a business objective and sample records, without a labeled dataset to establish predictive weights. The manager can override the visible order with a reason, while the original scores remain available for review.

## Reporting and interface

The manager's roll-rate view starts with loans observed at 1 to 30 DPD. It counts how many are observed at 31 to 60 DPD at the end, then divides by the starting loans with a known ending position. Missing ending records remain unknown and are shown separately. Loans above 60 DPD are counted separately too. The view aims for a seven-day comparison and uses the report dates available in the database.

The weekly score review freezes queue positions and compares upper, middle, and lower groups with confirmed mock payments, follow-ups, and manager overrides. Its payment window runs from Monday at 08:00 IST to the following Monday at 08:00. The completed demo week is labeled synthetic. If historical payment or activity data changes, opening a completed review saves a new report revision and retains the previous one. Payment records distinguish when payment happened from when confirmation arrived, although the demo payment form records both as the current time. This review helps examine the queue policy but does not prove that it caused more repayments.

The officer view puts the next case, DPD, and reasons together with large action buttons. Hindi and English labels support the field workflow. The manager's wider workspace separates the branch overview, imports, assignments, and review. Status labels distinguish scheduled work, pending sync, manager review, and handled cases. An uploaded conflict is shown as awaiting review so the officer can tell that their work reached the server.

## Tradeoffs and next steps

The demo uses fixed approved reminder templates and assumes a complete mock ledger. Weekly baselines are captured on demand from each officer's latest eligible Monday run saved by 08:00 IST. The report shows incomplete coverage when no valid run exists. Run history retention is specified in the design, and automated cleanup remains future work. Production operation would require integration with the lender's daily reports and payment confirmations, including evidence that the feeds are complete. The current contact window comes from the assignment. Actual operational compliance requires separate validation and monitoring.

The first rollout should track report freshness, completion and sync delays, and resolution time. Compare alternative queue rules on real outcomes with consistent observation windows before claiming a roll-rate improvement. Add durable notification delivery, review richer history where it is available, and validate field workflows with officers using low-end phones.

## Verification

The release passed the production build and 23 automated tests. These include six priority and time-window tests, five client sync and CSV-limit tests, and twelve API integration tests. API checks cover role and branch access, atomic imports, duplicate submissions, promise conflicts, concurrent borrower contacts, reminder approval, payment deduplication, reports, and manager overrides. Integration tests use an isolated PostgreSQL-compatible PGlite database.

Eight local browser checks covered manager and officer sign-in, report visibility, CSV upload, mobile layout, offline reload with a GPS visit, reconnect sync, and a 51-event outbox. Five hosted browser checks verified both roles, the weekly report, manager action restrictions, and an account switch with an earlier request still in flight. The public health endpoint verified the Neon connection. The offline write-and-sync workflow was checked locally against the built app. Hosted checks covered the deployed screens and session behavior. Field performance and collection outcomes still require a pilot.

The implementation record in the repository connects these decisions to the SQL schema, API modules, browser outbox, tests, and deployment instructions. [Implementation decisions](https://github.com/aditya-1310/field-collections/blob/main/docs/decisions.md)
