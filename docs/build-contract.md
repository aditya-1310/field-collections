# Implementation contract

The user approved deterministic prioritization; no learned model is required. Implement the agreed policy and label it explainable automation.

Stack: React + TypeScript + Tailwind via Vite; Express + TypeScript; parameterized PostgreSQL SQL. Root owns server/db.ts, schema.sql, seed.ts, policy.ts and infrastructure. Backend worker owns routes.ts, index.ts and API tests. Frontend worker owns src/ and public/. No worker changes shared files or package files without coordinating. Root owns commits.

API base /api; cookie sessions. JSON responses direct objects, lists wrapped as named property. Errors {error:string}. Frontend uses credentials same-origin. All financial numbers returned as JS numbers, dates YYYY-MM-DD.

- POST /auth/login {email,password} -> {user}; GET /auth/me -> {user}; POST /auth/logout.
- GET /loans -> {loans: Loan[], user, serverTime}; GET /loans/:id -> {loan,activities,payments,contacts}.
- GET /officers -> {officers: User[]}; GET /branches -> {branches}.
- POST /imports {csv:string,report_date:string} -> {batch_id,row_count,created,updated}; GET /imports -> {imports}.
- POST /loans/:id/assign {officer_id,reason} manager only.
- POST /sync {events:SyncEvent[]} -> {results:[{id,status:'applied'|'needs_review'|'rejected',error?}]}.
- GET /conflicts -> {conflicts}; POST /conflicts/:id/resolve {resolution:'keep_current'|'accept_incoming',note,current_promise_id,current_promise_version}.
- GET /promises -> {promises} joined borrower/loan/officer data.
- POST /loans/:id/contact {id:uuid,method:'call'|'message',language?:'hi'|'en'} -> {allowed,reason,message?}; rejected contact still audit.
- GET /loans/:id/reminder?language=hi -> {message,language,template_id}; template-generated immutable body; actual sends mocked and require officer tap.
- POST /loans/:id/payment {id:uuid,amount:number,reference:string} manager only -> confirmed mock payment, updates position proportionately only full arrears clears dpd; partial retains dpd.
- GET /dashboard -> {totals,officers,rollRate,activity,holds}; GET /weekly-review -> {weeks:[{id,label,start_date,end_date,synthetic,status,groups,loans}]}.
- POST /priority/override {officer_id,loan_ids:string[],reason} manager only.

CSV columns: loan_id,borrower_id,borrower_name,branch_code,pincode,phone,address,language,dpd,outstanding_amount,overdue_amount,late_installments. All contacts and names synthetic. Upload report date selected separately. Missing optional contact info blocks respective action. Whole-file validation precedes writes; stable source IDs, preserve assignments/promises/history.

Database exports: query(sql, params?) -> {rows,rowCount}; transaction(async tx=>...); tx.query same shape. All write transactions on PGlite serialized; PostgreSQL uses checked-out client. migrate() loads schema idempotently. seed() creates demo if empty. `policy.ts` exports todayIST(now?), contactAllowed(now?), rankLoans(loans, nextGroup='early', now?) returning Loan[]. db can run PGlite persistently for local zero-setup when no DATABASE_URL; deployed production requires PostgreSQL DATABASE_URL. Never expose secrets in errors/logs.

UI: 8 main destinations login, officer worklist, loan detail/outcome, promises, activity/sync, manager overview, import/assign, review/conflicts+weekly. Mobile-first Hindi/English toggle; large buttons, one calm light mint/ink design, no generic gradient dashboard. Offline IndexedDB stores assigned cases + user-bound outbox; service worker caches app shell only, never auth/API requests. Clear user caches on logout, warn on pending outbox. Reconnect/open/focus triggers sync; stable IDs and server acknowledgements. GPS optional denied/unavailable states explicit.

Acceptance: roles enforced backend, stable reimport, exact policy order, repeated event once, conflict preserved and resolved, offline refresh/reconnect, contact clock boundaries, English/Hindi draft, no actual payment/message delivery, weekly historical example labeled synthetic, build/typecheck/tests, decision log and deployment instructions.
