CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text UNIQUE NOT NULL,
  name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES branches(id),
  full_name text NOT NULL, email text UNIQUE NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('field_officer','branch_manager')),
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_branch_idx ON users(branch_id, role);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS officer_pincodes (
  officer_id uuid NOT NULL REFERENCES users(id), pincode text NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
  PRIMARY KEY(officer_id,pincode)
);
CREATE TABLE IF NOT EXISTS borrowers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_borrower_id text UNIQUE NOT NULL,
  display_name text NOT NULL, phone_number text, address text,
  pincode text CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$'),
  preferred_language text NOT NULL DEFAULT 'hi' CHECK (preferred_language IN ('hi','en')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_loan_id text UNIQUE NOT NULL,
  borrower_id uuid NOT NULL REFERENCES borrowers(id), branch_id uuid NOT NULL REFERENCES branches(id),
  assigned_officer_id uuid REFERENCES users(id), dpd integer NOT NULL CHECK (dpd>=0),
  outstanding_amount numeric(15,2) NOT NULL CHECK (outstanding_amount>=0),
  overdue_amount numeric(15,2) NOT NULL CHECK (overdue_amount>=0 AND overdue_amount<=outstanding_amount),
  report_date date NOT NULL, next_action_date date NOT NULL, last_handled_date date,
  late_installments integer CHECK (late_installments BETWEEN 0 AND 3), hold_reason text,
  version integer NOT NULL DEFAULT 1, last_imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loans_scope_idx ON loans(branch_id,assigned_officer_id);
CREATE INDEX IF NOT EXISTS loans_borrower_idx ON loans(borrower_id);
CREATE TABLE IF NOT EXISTS loan_assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), loan_id uuid NOT NULL REFERENCES loans(id),
  from_officer_id uuid REFERENCES users(id), to_officer_id uuid REFERENCES users(id),
  changed_by_user_id uuid NOT NULL REFERENCES users(id), method text NOT NULL CHECK(method IN ('auto_import','manager','seed')),
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_officer_id IS DISTINCT FROM to_officer_id)
);
CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES branches(id),
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id), file_name text NOT NULL DEFAULT 'overdue-loans.csv',
  file_hash text NOT NULL, report_date date NOT NULL,
  status text NOT NULL CHECK(status IN ('processing','completed','failed')),
  row_count integer, created_count integer NOT NULL DEFAULT 0, updated_count integer NOT NULL DEFAULT 0,
  error_summary jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS imports_success_idx ON import_batches(branch_id,report_date,file_hash) WHERE status='completed';
CREATE TABLE IF NOT EXISTS loan_daily_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), loan_id uuid NOT NULL REFERENCES loans(id),
  branch_id uuid NOT NULL REFERENCES branches(id), import_batch_id uuid REFERENCES import_batches(id),
  report_date date NOT NULL, dpd integer NOT NULL CHECK(dpd>=0),
  outstanding_amount numeric(15,2) NOT NULL CHECK(outstanding_amount>=0),
  overdue_amount numeric(15,2) NOT NULL CHECK(overdue_amount>=0), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(loan_id,report_date)
);
CREATE INDEX IF NOT EXISTS history_branch_date_idx ON loan_daily_history(branch_id,report_date);
CREATE TABLE IF NOT EXISTS sync_events (
  id uuid PRIMARY KEY, loan_id uuid NOT NULL REFERENCES loans(id),
  submitted_by_user_id uuid NOT NULL REFERENCES users(id), event_type text NOT NULL DEFAULT 'outcome',
  payload jsonb NOT NULL, base_promise_id uuid, base_promise_version integer,
  occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK(status IN ('applied','needs_review','resolved'))
);
CREATE TABLE IF NOT EXISTS officer_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), loan_id uuid NOT NULL REFERENCES loans(id),
  officer_id uuid NOT NULL REFERENCES users(id), sync_event_id uuid UNIQUE REFERENCES sync_events(id),
  contact_method text NOT NULL CHECK(contact_method IN ('call','visit')),
  outcome text NOT NULL CHECK(outcome IN ('paid_reported','promise_to_pay','not_reachable','dispute')),
  notes text NOT NULL DEFAULT '', occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  latitude double precision CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision CHECK(longitude BETWEEN -180 AND 180),
  location_accuracy_m double precision CHECK(location_accuracy_m>=0),
  CHECK((latitude IS NULL)=(longitude IS NULL))
);
CREATE INDEX IF NOT EXISTS activity_loan_time_idx ON officer_activities(loan_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS promises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), loan_id uuid NOT NULL REFERENCES loans(id),
  source_activity_id uuid UNIQUE REFERENCES officer_activities(id),
  promised_amount numeric(15,2) NOT NULL CHECK(promised_amount>0), due_date date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','kept','broken','superseded')),
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_promise_idx ON promises(loan_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS promises_loan_time_idx ON promises(loan_id,created_at DESC);
CREATE TABLE IF NOT EXISTS promise_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sync_event_id uuid UNIQUE NOT NULL REFERENCES sync_events(id),
  loan_id uuid NOT NULL REFERENCES loans(id), current_promise_id uuid REFERENCES promises(id),
  current_promise_version integer, current_promise_snapshot jsonb,
  reason text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  resolution text CHECK(resolution IN ('keep_current','accept_incoming')), resolution_note text,
  resolved_by_user_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE TABLE IF NOT EXISTS contact_attempts (
  id uuid PRIMARY KEY, loan_id uuid NOT NULL REFERENCES loans(id), borrower_id uuid NOT NULL REFERENCES borrowers(id),
  user_id uuid NOT NULL REFERENCES users(id), method text NOT NULL CHECK(method IN ('call','message')),
  allowed boolean NOT NULL, reason text NOT NULL, message text, language text CHECK(language IN ('hi','en')),
  work_date date NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS borrower_contacts (
  borrower_id uuid NOT NULL REFERENCES borrowers(id), work_date date NOT NULL,
  interaction_id uuid NOT NULL, PRIMARY KEY(borrower_id,work_date)
);
CREATE TABLE IF NOT EXISTS mock_payments (
  id uuid PRIMARY KEY, loan_id uuid NOT NULL REFERENCES loans(id),
  confirmed_by_user_id uuid NOT NULL REFERENCES users(id),
  promise_id uuid REFERENCES promises(id), amount numeric(15,2) NOT NULL CHECK(amount>0),
  reference text NOT NULL, occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(loan_id,reference)
);
CREATE INDEX IF NOT EXISTS payments_loan_time_idx ON mock_payments(loan_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS officer_queue_state (
  officer_id uuid NOT NULL REFERENCES users(id), work_date date NOT NULL,
  next_group text NOT NULL DEFAULT 'early' CHECK(next_group IN ('early','recovery')),
  PRIMARY KEY(officer_id,work_date)
);
CREATE TABLE IF NOT EXISTS priority_overrides (
  officer_id uuid NOT NULL REFERENCES users(id), work_date date NOT NULL,
  manager_id uuid NOT NULL REFERENCES users(id), loan_ids jsonb NOT NULL,
  ordering_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(officer_id,work_date)
);
CREATE TABLE IF NOT EXISTS priority_override_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), officer_id uuid NOT NULL REFERENCES users(id),
  manager_id uuid NOT NULL REFERENCES users(id), work_date date NOT NULL, loan_ids jsonb NOT NULL,
  ordering_facts jsonb NOT NULL DEFAULT '{}'::jsonb, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS priority_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), officer_id uuid NOT NULL REFERENCES users(id),
  branch_id uuid NOT NULL REFERENCES branches(id), work_date date NOT NULL, policy_version text NOT NULL,
  fingerprint text NOT NULL, eligible_count integer NOT NULL, computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(officer_id,work_date,fingerprint)
);
CREATE TABLE IF NOT EXISTS loan_priority_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES priority_runs(id) ON DELETE CASCADE,
  loan_id uuid NOT NULL REFERENCES loans(id), base_rank integer NOT NULL, score numeric(5,2) NOT NULL,
  reasons jsonb NOT NULL, input_facts jsonb NOT NULL, UNIQUE(run_id,loan_id)
);
CREATE TABLE IF NOT EXISTS weekly_review_members (
  week_start date NOT NULL, week_end date NOT NULL, branch_id uuid NOT NULL REFERENCES branches(id),
  officer_id uuid NOT NULL REFERENCES users(id), loan_id uuid NOT NULL REFERENCES loans(id),
  score_id uuid REFERENCES loan_priority_scores(id), base_rank integer NOT NULL, queue_count integer NOT NULL,
  baseline_dpd integer NOT NULL, baseline_overdue numeric(15,2) NOT NULL, synthetic boolean NOT NULL DEFAULT false,
  PRIMARY KEY(week_start,loan_id)
);
CREATE TABLE IF NOT EXISTS weekly_report_revisions (
  branch_id uuid NOT NULL REFERENCES branches(id), week_start date NOT NULL,
  revision integer NOT NULL CHECK (revision>0), fingerprint text NOT NULL, report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(branch_id,week_start,revision),
  UNIQUE(branch_id,week_start,fingerprint)
);
