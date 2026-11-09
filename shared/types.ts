export type Role = 'field_officer' | 'branch_manager';
export interface User {
  id: string;
  branch_id: string;
  full_name: string;
  email: string;
  role: Role;
}
export interface PromiseRecord {
  id: string;
  loan_id: string;
  promised_amount: number;
  due_date: string;
  status: string;
  version: number;
}
export interface Loan {
  id: string;
  external_loan_id: string;
  borrower_id: string;
  branch_id: string;
  assigned_officer_id: string | null;
  borrower_name: string;
  phone_number: string | null;
  address: string | null;
  pincode: string | null;
  preferred_language: string;
  dpd: number;
  outstanding_amount: number;
  overdue_amount: number;
  report_date: string;
  next_action_date: string;
  late_installments: number | null;
  last_handled_date: string | null;
  hold_reason: string | null;
  promise: PromiseRecord | null;
  officer_name: string | null;
  state: string;
  score: number | null;
  rank: number | null;
  reasons: string[];
  group: 'early' | 'recovery';
  version: number;
}
export interface SyncEvent {
  id: string;
  loan_id: string;
  outcome: 'paid_reported' | 'promise_to_pay' | 'not_reachable' | 'dispute';
  contact_method: 'call' | 'visit';
  notes: string;
  occurred_at: string;
  promised_amount?: number;
  due_date?: string;
  base_promise_id: string | null;
  base_promise_version: number | null;
  latitude?: number;
  longitude?: number;
  location_accuracy_m?: number;
}
