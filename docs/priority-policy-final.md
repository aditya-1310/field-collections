# Collection work priority policy

This is the design baseline after a seven-lens concept review. The implementation applies its queue ordering and reporting rules with some state stored in fewer tables. See [implementation decisions](./decisions.md) and `server/schema.sql` for the shipped layout. The policy choices replace the earlier illustrative point weights and serve as explicit demo assumptions.

## Purpose and evidence boundary

Produce one explainable work list per officer. Prevent loans at 1-30 DPD from moving into 31-60 while continuing work on loans already above 30. DPD means days past due. The assignment as recorded in conversation asks for DPD, promise history, payment history, amount, a score with reasons, manager override, and weekly review. It uses both AI or automation and model terminology. This design is deterministic automation, not trained AI. A strict learned-model acceptance requirement remains to be verified. No labeled historical training dataset has been established.

The score represents queue position. Explainability comes from ordered rules and recorded source facts. A pilot with real outcomes would be needed to measure any change in roll rate.

## 1. Determine whether follow-up is due

Keep all loans visible, including held and scheduled cases. Only actionable cases enter Work today.

| Condition | Treatment |
| --- | --- |
| Confirmed DPD zero and overdue amount zero | Cleared from collection work; retain history |
| Future active promise | Scheduled for its due date; no additional repayment chase today |
| Active promise due today | Eligible for today's reminder; not broken yet |
| Unfulfilled promise after its date | Broken only if confirmed payment information covers the due date; otherwise needs verification |
| Open dispute, promise conflict, or payment reported awaiting confirmation | Needs review; preserve current state and require resolution first |
| Missing/contradictory financial facts or source data older than today | Needs data check, with last reported date shown |
| No assigned active officer | Needs assignment |
| Borrower already had an accepted mock contact initiation or recorded visit today | Handled today; suppress repeat automated chase recommendations across their loans |
| Current facts, positive DPD and overdue amount, assigned officer, no hold, due action | Work today |

Use India time. For this demo, a current position requires today's source date or an explicit mocked external update supplying today's financial position. A date supplied by the uploader cannot independently prove freshness. Never advance stale DPD simply by adding elapsed days. Partial payment does not reset DPD or clear arrears unless the confirmed external position supports that result.

The one-outbound-attempt-or-visit-per-borrower-per-day rule is a conservative product assumption, not a legal claim. For a mock contact, backend acceptance consumes the allowance immediately, even if the simulated delivery later fails or the officer never records an outcome. Commit that accepted attempt before replying; the same request ID returns the existing result on retry. Blocked attempts do not consume it. A visit already performed consumes it when recorded for that visit's occurrence date. Record an additional reported offline visit honestly and flag the duplicate; the application cannot prevent physical visits that occurred outside it. Inbound information and logging an interaction that already happened remain possible.

One contact identifies a primary loan and any additional authorized loans explicitly included in that attempt or visit. Only included loans get their own next-action-date update, and an outcome is recorded per loan only when the officer supplies it. Sibling loans are held from another contact today, but their dates and promises are not falsely marked handled or changed. Show both loan count and distinct borrower count, and display only related loans the officer is authorized to access. A borrower-wide contact restriction must not disclose another branch's loan details. Exactly one turn is consumed using the primary loan's Early/Recovery group captured when the mock contact is accepted or the visit is recorded. Further outcomes linked to the same interaction do not consume extra turns. Invalidate the queues of all officers holding that borrower's loans when its daily allowance is consumed.

A promise expires at the start of the next India calendar day; compare cumulative confirmed payments matched to it with its promised amount before marking broken. Payments must have occurred by the end of the due date to fulfill it on time. Confirmation received later does not turn an on-time payment into a late payment. The mock source must supply a coverage-through date; insufficient confirmation coverage leads to verification state rather than a nonpayment claim.

When several states apply, display all flags with this primary-action precedence: data/confirmation check, needs review, confirmed cleared, needs assignment, handled today, future scheduled, actionable. A payment still awaiting confirmation is a verification state. Display a valid cleared state only when current source facts establish it. Show the responsible action and owner for each excluded case; the manager sees counts by reason, oldest waiting date, source freshness, and assigned/unassigned totals. An empty Work today list must explain held work rather than suggest all loans were cleared.

Contact actions require an online server check of role, assignment, borrower-level duplicate-contact state, and 08:00 <= India time < 19:00. Record allowed and blocked attempts. Viewing lists, logging outcomes, and syncing records are separate from initiating contact. The demo mocks contact and payment systems.

## 2. Preserve carried-over work

Give each loan a next-action date and action type. First eligibility sets the date to today. Reimports never reset it. A future promise schedules its due date. A material change can bring a future action forward to today; it cannot silently postpone outstanding work. Holds retain the due date, so released cases return with their actual waiting time. An accepted mock contact or recorded visit schedules its explicitly included loans for tomorrow by default, even if an outcome has not yet arrived. An accepted outcome can replace that default with its future promise date or a review hold. A late-synced prior-day visit must not overwrite a more recent supported action date; preserve its history and reconcile using state revisions. Manager deferrals require a recorded date and reason.

Order the oldest due action date first. This is the first exception to simply sorting by DPD: work an officer could not finish yesterday precedes newly due work today. This prevents permanent neglect of smaller or younger cases. It does not guarantee capacity; show overdue-work counts for manager reassignment when work exceeds capacity.

## 3. Give early and older delinquency turns

Within the same action-date group, create two groups: Early for DPD 1-30 and Recovery for DPD 31 or higher. Recovery includes 61 and above; this grouping makes no NPA classification claim.

Alternate Early, Recovery, Early, Recovery. If a group is empty, use the other. Start the work date with Early because preventing new crossings is the stated goal. This equal-turn policy is an explicit fairness assumption, not a data-optimized ratio. It gives a 29-DPD case attention without indefinitely putting a 60-DPD case behind all early loans.

Persist the next group per officer/work date. An accepted mock contact initiation or a newly recorded visit consumes exactly one turn using its primary loan, as defined above. Change the turn to the opposite of that group. Refreshes and imports must not reset the turn. Blocked or duplicate submissions do not advance it; a simulated delivery failure after acceptance does not restore it. Carry the turn across action-date groups; serving the only available group leaves the missing group next when it becomes available. Late-synced activity from a previous day does not advance today's turn. Use one interaction ID to link contact, outcomes, and the previous/new turn in the audit record.

## 4. Sort within each group and action date

Apply the following sequence; later factors only break ties:

1. Higher DPD first. Early: 30 before 29 before 15. Recovery: 75 before 60 before 35.
2. A confirmed, unresolved broken promise before none. Fulfilled or superseded promises do not count as currently broken.
3. More late payments among the three previous scheduled installments before the current delinquency. Use this only if every loan remaining tied has complete, comparable history for all three installments. Otherwise skip this factor for that whole tied group and flag incomplete history. Pairwise skipping is forbidden because it can create inconsistent sorting.
4. Larger overdue amount first. Total outstanding is displayed but not used for this tie-breaker.
5. Exact ties use external loan ID ascending for stable display, not as a risk signal.

An installment is late only when sufficiently complete authoritative records show that cumulative payments occurring by its due-date deadline did not cover its scheduled amount. Use payment occurrence time, not confirmation receipt time. Incomplete coverage makes the installment unknown. The three-installment window is a disclosed recency/simplicity choice, not a proven optimum. Names, phone numbers, language, and location do not affect credit priority; pincode remains an assignment input. Missing history is neither good nor bad history.

## 5. Worked example

All cases below belong to one officer, are due today, have current information and complete comparable history, and have no holds. Starting turn: Early.

| Loan | DPD | Broken promise | Prior late installments out of 3 | Overdue INR |
| --- | ---: | --- | ---: | ---: |
| A | 29 | Yes | 2 | 5,000 |
| B | 29 | No | 3 | 50,000 |
| C | 15 | Yes | 3 | 80,000 |
| D | 60 | Yes | 1 | 10,000 |
| E | 35 | No | 2 | 20,000 |

Early is A, B, C. Recovery is D, E. Combined work order is **A, D, B, E, C**. The large balance of B cannot beat A's broken promise. C's larger amount does not beat the higher DPD of A and B.

An eligible case F due yesterday precedes these today's-due cases. If F is a Recovery case and gets handled, the next turn is Early. A case G promised for tomorrow is Scheduled, and a disputed case H is Needs review, regardless of DPD or amount.

## 6. Display score and reasons

After building the base queue, for N loans and one-based position r calculate `queue_score = round(100 * (N - r + 1) / N, 2)`. For the five cases above the scores are 100, 80, 60, 40, 20. One eligible loan scores 100 because it is first, not because it is extremely risky. Empty queues have no scored rows. This is an explicit position scale, not a predictive model.

Show Queue priority with position such as 3 of 5, officer, plan date and calculation time. Both role views read the same saved score. Scores across officers/days are not comparable as absolute urgency. The manager's branch view groups by officer rather than pretending these values form a universal risk ranking. Held, cleared and scheduled cases show their state without a current queue score; any previous score is labeled historical. Exact rule ties can have different positions solely from ID ordering; label them equal business priority.

Keep a separate scheduling explanation such as Carried over from yesterday or Recovery turn. Show up to three supported ordering facts in precedence order, such as 29 days overdue, an unmet promise, and two of three prior installments late. Do not fabricate three reasons or claim additive feature contributions. Show missing-data information separately. Preserve input facts and policy version for every saved result.

Managers can reorder only eligible loans in the current plan with a reason. Store the complete validated order separately, label Manager override, and retain original base ranks/scores. Overrides never bypass holds, permissions or contact hours. Routine removal of completed, cleared, or newly held cases preserves the relative order of remaining eligible IDs and links the inherited override to the original decision. New eligible cases, reassignment, a new work date, or changed ordering facts of a remaining case invalidate the override, restore the base order, and show a concrete reason to the manager. A completion-driven turn change alone is routine depletion, not invalidation. For example, override C,A,D,B,E followed by handling C leaves A,D,B,E in that manual order; a newly eligible F invalidates it for review.

## Detailed Implementation Plan

### State and publication

Extend the working schema with these responsibilities; none has been implemented:

- `loan_followup_state`: one per loan, action date/type, hold state/reason, first eligibility, last handled time, revision.
- `officer_queue_state`: one per officer/date, next group and revision. Advance transactionally with the accepted contact/visit interaction, deduplicated by interaction ID.
- `priority_runs`: officer, branch, date/time, policy version, eligible count, starting group, source revision/fingerprint and status. Publish a run with all score rows atomically; do not publish if source state changed while calculating.
- `loan_priority_scores`: run ID, loan ID, group, base rank, score, action date, reasons, comparison keys and exact input facts. Unique run/loan. Store the run's population to reproduce relative scores.
- `priority_overrides`: origin run ID, manager, reason, time and a validated full permutation of eligible loan IDs; inherited run reference and active/invalidated state with reason.
- `weekly_review_members`: period, frozen score-row ID, officer and branch at baseline, loan and baseline state. Preserve membership, including missing-data coverage flags.

Use a borrower-level transactional check and a unique borrower/date allowance record, so two officers cannot simultaneously initiate mock contact against different loans of the same borrower. Contact-attempt audit, activity history, payment confirmations and queue-state changes remain distinct records linked by the initiating interaction/event ID. Record allowed/blocked reasons, authoritative server decision time, primary loan, related outcomes, previous/new turn, and the queue run used. This provides an audit trail without requiring a tracing platform.

Mark affected officer queues dirty after accepted import changes, assignment changes, confirmed payments, accepted promises, review resolution, accepted mock contact/visit, recorded outcomes, deferral, and a work-date transition. Borrower-wide contact state invalidates all affected owners; reassignment invalidates both owners. An unchanged retry or failed import does not create another run. Coalesce changes until the next queue read and build one run for the current revision rather than rebuilding for each row/event separately. Recalculate the whole affected queue because a relative score depends on its population.

Track last successful run, current source revision, pending/failed rebuild state, and a concise failure reason. Serialize rebuilds per officer and attempt publication at most twice per queue read. If revisions keep changing or calculation fails, return the last saved plan labeled Updating or Needs refresh, not current; show a Retry action. New mock contacts still require fresh backend checks. Show cached offline plans with timestamp and pending local updates; they are not guaranteed current.

Implementation performance target for the demo is 500 active loans overall and 50 in a single officer queue, with larger loads explicitly unverified. Full-population history is acceptable only within this bounded target and with coalescing. Retain current runs and all runs referenced by contacts, overrides, or weekly reviews for the submission lifetime. Unreferenced intermediate runs may expire after seven days. This is retention of derived queue calculations, never deletion of loan/activity/payment history. Performance with database writes still needs implementation testing; the executable design check tests sorting only.

This project has no implemented data migration to perform. For first adoption, preserve an existing supported next-action date; if no evidence exists, use the adoption date and label prior waiting time unknown. Never invent historical waiting. Any illustrative earlier scores are legacy/demo values and must not be presented as this policy's queue scores. Seeded historical examples are labeled synthetic.

### Weekly review

Freeze a complete current eligible queue at Monday 08:00 India time. If a current run is unavailable, flag that officer as uncovered rather than taking a future score. Outcomes cover that instant until the next Monday 08:00, end exclusive. Record confirmed payment occurrence and receipt times; include occurrence within the interval. Reports remain in progress until the interval ends and display the latest reconciliation time. Late confirmation creates a new report version, not a silent rewrite.

Keep two different cohorts. Queue-order review uses the frozen eligible queue and shows position groups, counts, confirmed payments/amounts, interventions and overrides. Portfolio roll reporting freezes all loans known to be at 1-30 DPD at baseline, including scheduled and held cases. Record work eligibility as an attribute, not an inclusion filter. Report portfolio loans without a valid baseline separately as uncovered.

For the portfolio report, measure endpoint transition: of baseline 1-30 DPD loans, how many have observed 31-60 DPD at the end? A loan that crosses and then cures before the end is not an endpoint roll; do not label this metric ever crossed. Also show any end-DPD above 60 separately as further deterioration. An absent end record is unknown, not a cure. With baseline N, known endpoint K and observed 31-60 transitions R, show R/K with coverage K/N and unknown count N-K; if K=0, the rate is unavailable. Never present R/K as a complete-population rate when coverage is partial. Show the full-cohort possible range R/N to (R+N-K)/N as a coverage bound, not an estimated actual rate. Queue-score review is separate from this portfolio metric.

Payment outcomes alone do not prove score accuracy or causality because officers intervene according to the order. Demo completed historical weeks are explicitly synthetic. A weekly endpoint rate must not be compared directly with the assignment's assumed monthly roll-rate target without aligning its cohort and observation horizon.

### Acceptance examples

- A, D, B, E, C produces 100, 80, 60, 40, 20.
- 1 and 30 DPD are Early; 31, 60, 61 and 90+ are Recovery without an NPA claim.
- Old due dates survive imports; eligible carryover precedes new work.
- Serving Early then refreshing starts Recovery if available; duplicate events do not advance twice.
- Empty groups fall through; no eligible cases means an empty plan, not an exception.
- Incomplete history disables only that entire tied group's history comparison; order is deterministic and transitive.
- Amount never outranks earlier rules; future promises and holds never become fresh chase recommendations.
- Two concurrent mock contacts for one borrower produce at most one allowed attempt.
- Publication is all-or-nothing and rejects stale source state.
- Both roles show the same base score; overrides are visible; weekly review never uses future facts at baseline.
- A two-loan borrower consumes one contact allowance and one turn; only explicitly addressed loans advance their own dates.
- An accepted mock attempt without a later outcome still consumes the daily allowance; identical retry has no additional effects.
- C,A,D,B,E override followed by handling C preserves A,D,B,E; a new eligible F invalidates it visibly.
- Payment occurring before its due deadline but confirmed afterward is on time once confirmed; incomplete coverage remains unknown.
- An all-held portfolio shows counts and responsible actions; a stale run cannot be labeled current.
- Scheduled/held baseline 1-30 DPD cases remain in the portfolio roll cohort; missing endpoints reduce reported coverage, not falsely improve outcomes.

## Limits

Equal alternation, three-installment history, next-day follow-up, and the daily contact cap are explicit operational assumptions. They are defensible and testable, not proven best. Strict freshness holds may reduce work if an import is late. No schedule guarantees service under sustained overload. The queue score is deliberately relative; it sacrifices absolute-risk comparison to avoid inventing predictive meaning. Acceptance of automation in place of a learned model must be verified. Real outcomes can later support changing the policy or training a model with valid evaluation.
