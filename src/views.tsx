import { useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  CloudOff,
  Download,
  FileUp,
  LocateFixed,
  MapPin,
  MessageSquare,
  Phone,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
} from 'lucide-react';
import type { Loan, PromiseRecord, SyncEvent, User } from '../shared/types';
import {
  api,
  dateLabel,
  errorMessage,
  money,
  post,
  timeLabel,
  today,
} from './api';
import type { OutboxEntry } from './offline';
import {
  Badge,
  Empty,
  Loading,
  Modal,
  Notice,
  PanelHeading,
  SectionTitle,
  StateBadge,
  TextLink,
  useRemote,
} from './ui';
import { importValidationError } from './sync';

export type Language = 'en' | 'hi';
export const words = (language: Language, english: string, hindi: string) =>
  language === 'hi' ? hindi : english;
const outcomeLabels: Record<SyncEvent['outcome'], string> = {
  paid_reported: 'Payment reported',
  promise_to_pay: 'Promise to pay',
  not_reachable: 'Not reachable',
  dispute: 'Dispute',
};
interface Activity {
  id: string;
  outcome: string;
  contact_method: string;
  notes: string;
  occurred_at: string;
  officer_name?: string;
  borrower_name?: string;
  external_loan_id?: string;
  latitude?: number;
  longitude?: number;
}
interface Payment {
  id: string;
  amount: number;
  reference: string;
  occurred_at: string;
}
interface Contact {
  id: string;
  method: string;
  allowed: boolean;
  reason: string;
  occurred_at: string;
  message?: string;
}
interface LoanDetails {
  loan: Loan;
  activities: Activity[];
  payments: Payment[];
  contacts: Contact[];
}
interface PromiseItem extends PromiseRecord {
  borrower_name: string;
  external_loan_id: string;
  officer_name: string;
}
interface Dashboard {
  totals: {
    loans: number;
    overdue_amount: number;
    ready: number;
    broken_promises: number;
    unassigned: number;
    open_conflicts: number;
  };
  officers: {
    id: string;
    full_name: string;
    assigned: number;
    ready: number;
  }[];
  rollRate: {
    rate: number | null;
    baseline: number;
    known: number;
    rolled: number;
    unknown: number;
    start_date: string;
    end_date: string;
  };
  activity: Activity[];
  holds: unknown[];
}
interface Conflict {
  id: string;
  loan_id: string;
  external_loan_id: string;
  borrower_name: string;
  officer_name: string;
  created_at: string;
  reason: string;
  current_promise_id: string | null;
  current_promise_version: number | null;
  current_promise: PromiseRecord | null;
  incoming: {
    due_date?: string;
    promised_amount?: number;
    notes?: string;
    occurred_at?: string;
  };
}
interface Week {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  synthetic: boolean;
  status: string;
  groups: {
    label: string;
    count: number;
    paid_count: number;
    amount: number;
  }[];
  loans: {
    external_loan_id: string;
    borrower_name: string;
    score: number;
    amount: number;
    paid: boolean;
  }[];
}
interface ImportBatch {
  id: string;
  report_date: string;
  status: string;
  row_count: number;
  created_at: string;
  created?: number;
  updated?: number;
  error?: string;
}

export function Worklist({
  loans,
  language,
  manager,
  onOpen,
  onAssign,
  onReorder,
}: {
  loans: Loan[];
  language: Language;
  manager: boolean;
  onOpen: (loan: Loan) => void;
  onAssign: () => void;
  onReorder: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [officer, setOfficer] = useState('all');
  const officers = [
    ...new Map(
      loans
        .filter((loan) => loan.assigned_officer_id)
        .map((loan) => [
          loan.assigned_officer_id!,
          loan.officer_name || 'Officer',
        ]),
    ).entries(),
  ];
  const visible = loans.filter(
    (loan) =>
      (filter === 'all' ||
        (filter === 'ready'
          ? loan.state === 'ready'
          : filter === 'review'
            ? ['review', 'stale', 'unassigned'].includes(loan.state)
            : loan.state === filter)) &&
      (officer === 'all' || loan.assigned_officer_id === officer) &&
      `${loan.borrower_name} ${loan.external_loan_id} ${loan.pincode || ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <SectionTitle
        eyebrow={words(
          language,
          'A LITTLE CLARITY. A BETTER FIELD DAY.',
          'हर दिन, सही मामले पहले।',
        )}
        title={
          manager
            ? 'Branch worklist'
            : words(language, 'Your work, in order.', 'आज की कार्य सूची।')
        }
        description={words(
          language,
          'Start with due follow-ups. Every priority comes with a reason.',
          'आज के ज़रूरी फ़ॉलो-अप देखें। हर प्राथमिकता की वजह जानें।',
        )}
        action={
          manager ? (
            <div className="button-row">
              <button className="button secondary" onClick={onReorder}>
                Reorder cases
              </button>
              <button className="button primary" onClick={onAssign}>
                <Users size={17} />
                Assign cases
              </button>
            </div>
          ) : (
            <span className="date-chip">
              <CalendarDays size={16} />
              {dateLabel(today())}
            </span>
          )
        }
      />
      <div className="work-summary">
        <div>
          <span className="small-dot green" />
          <strong>
            {loans.filter((l) => l.state === 'ready').length}
          </strong>{' '}
          {words(language, 'ready for follow-up', 'फ़ॉलो-अप के लिए तैयार')}
        </div>
        <span>
          {words(
            language,
            'Early overdue + recovery, taking turns.',
            'शुरुआती बकाया और पुराने मामलों को बारी-बारी से देखें।',
          )}
        </span>
      </div>
      <div className="panel work-panel">
        <div className="toolbar">
          <div className="tabs">
            {[
              ['all', 'All cases', 'सभी'],
              ['ready', 'Due today', 'आज'],
              ['scheduled', 'Scheduled', 'आगे की तारीख'],
              ['review', 'Needs attention', 'समीक्षा'],
            ].map(([key, en, hi]) => (
              <button
                key={key}
                className={filter === key ? 'active' : ''}
                onClick={() => setFilter(key)}
              >
                {words(language, en, hi)}
              </button>
            ))}
          </div>
          <div className="toolbar-inputs">
            {manager && (
              <select
                aria-label="Filter by officer"
                value={officer}
                onChange={(event) => setOfficer(event.target.value)}
              >
                <option value="all">All officers</option>
                {officers.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <label className="search-field">
              <Search size={17} />
              <input
                aria-label="Search cases"
                placeholder={words(
                  language,
                  'Name, loan ID or pincode',
                  'नाम, लोन ID या पिनकोड',
                )}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="work-table-head">
          <span>CASE / BORROWER</span>
          <span>OVERDUE</span>
          <span>WHY THIS CASE</span>
          <span>STATUS</span>
          <span />
        </div>
        {visible.length ? (
          visible.map((loan, index) => (
            <button
              className="case-row"
              key={loan.id}
              onClick={() => onOpen(loan)}
            >
              <div className="case-identity">
                <span
                  className={`case-index ${loan.state === 'ready' ? 'ranked' : ''}`}
                >
                  {loan.rank ?? <span>–</span>}
                </span>
                <div>
                  <strong>{loan.borrower_name}</strong>
                  <div className="case-meta">
                    {loan.external_loan_id}
                    <span>·</span>
                    {manager
                      ? loan.officer_name || 'Unassigned'
                      : loan.pincode || 'No pincode'}
                  </div>
                </div>
              </div>
              <div className="case-amount">
                <strong>{money(loan.overdue_amount)}</strong>
                <span>
                  <b className={loan.dpd > 30 ? 'recovery-text' : ''}>
                    {loan.dpd} DPD
                  </b>
                  <span className="case-group">
                    {' '}
                    · {loan.group === 'early' ? 'Early overdue' : 'Recovery'}
                  </span>
                </span>
              </div>
              <div className="case-reasons">
                {loan.reasons.length ? (
                  loan.reasons.slice(0, 3).map((reason, i) => (
                    <span key={i}>
                      {i === 0 && <Sparkles size={12} />} {reason}
                    </span>
                  ))
                ) : (
                  <span>
                    {loan.hold_reason || 'Waiting for the next follow-up'}
                  </span>
                )}
              </div>
              <div className="case-state">
                <StateBadge state={loan.state} />
                {(loan as Loan & { manager_override?: boolean })
                  .manager_override && (
                  <Badge tone="amber">Manager order</Badge>
                )}
                {loan.promise && (
                  <small>
                    {words(language, 'Promise', 'वादा')}{' '}
                    {dateLabel(loan.promise.due_date)}
                  </small>
                )}
                {loan.score !== null && (
                  <small>
                    {words(language, 'Queue score', 'कतार स्कोर')} {loan.score}
                    /100
                  </small>
                )}
              </div>
              <ChevronRight size={18} className="case-arrow" />
            </button>
          ))
        ) : (
          <Empty
            title={words(
              language,
              'No cases in this view',
              'इस सूची में कोई मामला नहीं है',
            )}
          >
            {words(
              language,
              'Try another filter or search. Imported cases will appear here.',
              'फ़िल्टर या खोज बदलें। इम्पोर्ट किए गए मामले यहाँ दिखेंगे।',
            )}
          </Empty>
        )}
        <div className="table-footer">
          <span>
            {visible.length} {words(language, 'cases', 'मामले')}
          </span>
          <span>
            {words(
              language,
              'Priority is guidance, not a default prediction.',
              'प्राथमिकता मार्गदर्शन है, भुगतान न होने की भविष्यवाणी नहीं।',
            )}
          </span>
        </div>
      </div>
    </>
  );
}

export function Overview({
  loans,
  revision,
  online,
  onNavigate,
  onOpen,
}: {
  loans: Loan[];
  revision: number;
  online: boolean;
  onNavigate: (view: string) => void;
  onOpen: (loan: Loan) => void;
}) {
  const { data, loading, error } = useRemote<Dashboard>(
    '/dashboard',
    online,
    revision,
  );
  if (loading && !data) return <Loading />;
  const totals = data?.totals;
  const rate = data?.rollRate;
  return (
    <>
      <SectionTitle
        eyebrow="BRANCH OPERATIONS"
        title="A clearer picture of today."
        description="Know what needs attention, and keep your team moving."
        action={
          <button
            className="button primary"
            onClick={() => onNavigate('imports')}
          >
            <Upload size={17} />
            Import overdue loans
          </button>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {!online && (
        <Notice>
          Connect to refresh branch reports. Your cached cases are still
          available.
        </Notice>
      )}
      <div className="stats-grid">
        <Stat
          label="Overdue portfolio"
          value={totals ? money(totals.overdue_amount) : '—'}
          caption={
            totals
              ? `${totals.loans} active cases in your branch`
              : 'Waiting for branch data'
          }
          accent
        />
        <Stat
          label="Ready for follow-up"
          value={totals?.ready ?? '—'}
          caption="Cases that need attention today"
        />
        <Stat
          label="Broken promises"
          value={totals?.broken_promises ?? '—'}
          caption="Promised date passed without payment"
          warning
        />
        <Stat
          label="Manager review"
          value={totals?.open_conflicts ?? '—'}
          caption={
            totals
              ? `${totals.unassigned} cases also need an officer`
              : 'Offline changes needing a decision'
          }
        />
      </div>
      <div className="overview-grid">
        <section className="panel">
          <PanelHeading
            title="The follow-up board"
            meta="Current cases across your branch"
            action={
              <TextLink onClick={() => onNavigate('work')}>
                View worklist
              </TextLink>
            }
          />
          <div className="overview-cases">
            {loans
              .filter((loan) => loan.state === 'ready')
              .slice(0, 5)
              .map((loan) => (
                <button
                  className="compact-case"
                  key={loan.id}
                  onClick={() => onOpen(loan)}
                >
                  <div className="avatar small">
                    {loan.borrower_name.slice(0, 1)}
                  </div>
                  <div className="grow">
                    <strong>{loan.borrower_name}</strong>
                    <small>
                      {loan.external_loan_id} ·{' '}
                      {loan.officer_name || 'Unassigned'}
                    </small>
                  </div>
                  <div className="align-right">
                    <strong>{money(loan.overdue_amount)}</strong>
                    <small>{loan.dpd} days overdue</small>
                  </div>
                  <ChevronRight size={16} />
                </button>
              ))}
            {!loans.some((loan) => loan.state === 'ready') && (
              <Empty title="No follow-ups ready">
                Open the worklist to see scheduled and held cases.
              </Empty>
            )}
          </div>
        </section>
        <section className="panel roll-panel">
          <PanelHeading
            title="Are cases getting worse?"
            meta="Movement from 1–30 to 31–60 DPD"
          />
          <div className="roll-number">
            {rate?.rate === null || rate?.rate === undefined
              ? '—'
              : `${Number(rate.rate).toFixed(1)}%`}
            <span>observed roll rate</span>
          </div>
          <div className="roll-track">
            <div style={{ width: `${Math.min(100, rate?.rate || 0)}%` }} />
          </div>
          {rate && (
            <>
              <div className="roll-counts">
                <div>
                  <strong>{rate.rolled}</strong>
                  <span>rolled forward</span>
                </div>
                <div>
                  <strong>{rate.known}</strong>
                  <span>known outcomes</span>
                </div>
                <div>
                  <strong>{rate.unknown}</strong>
                  <span>missing updates</span>
                </div>
              </div>
              <p className="footnote">
                {dateLabel(rate.start_date)} – {dateLabel(rate.end_date)} ·
                Starting cohort: {rate.baseline} loans. Missing updates remain
                unknown.
              </p>
            </>
          )}
          <button
            className="button secondary full"
            onClick={() => onNavigate('review')}
          >
            Open weekly score review
            <ArrowRight size={16} />
          </button>
        </section>
      </div>
      <div className="overview-grid">
        <section className="panel">
          <PanelHeading
            title="Your field team"
            meta="Assignment stays with an officer until you change it"
          />
          <div className="team-list">
            {data?.officers.map((officer) => (
              <div className="team-row" key={officer.id}>
                <div className="avatar small">
                  {officer.full_name.slice(0, 1)}
                </div>
                <div className="grow">
                  <strong>{officer.full_name}</strong>
                  <small>{officer.assigned} assigned cases</small>
                </div>
                <div className="mini-bar">
                  <span
                    style={{
                      width: `${Math.min(100, officer.assigned ? (officer.ready / officer.assigned) * 100 : 0)}%`,
                    }}
                  />
                </div>
                <span className="team-due">{officer.ready} due</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <PanelHeading
            title="Latest field notes"
            meta="Visits and calls recorded by your team"
          />
          <ActivityList activities={data?.activity.slice(0, 4) || []} />
        </section>
      </div>
    </>
  );
}
function Stat({
  label,
  value,
  caption,
  accent = false,
  warning = false,
}: {
  label: string;
  value: string | number;
  caption: string;
  accent?: boolean;
  warning?: boolean;
}) {
  return (
    <div className={`stat ${accent ? 'accent' : ''}`}>
      <span>
        {label}
        {warning && <span className="small-dot amber" />}
      </span>
      <strong>{value}</strong>
      <p>{caption}</p>
    </div>
  );
}
function ActivityList({ activities }: { activities: Activity[] }) {
  return activities.length ? (
    <div className="timeline">
      {activities.map((activity) => (
        <div className="timeline-item" key={activity.id}>
          <span className="timeline-dot" />
          <div>
            <strong>
              {activity.borrower_name || activity.officer_name || 'Case update'}{' '}
              <Badge>
                {outcomeLabels[activity.outcome as SyncEvent['outcome']] ||
                  activity.outcome}
              </Badge>
            </strong>
            <p>
              {activity.notes ||
                `${activity.contact_method === 'visit' ? 'Field visit' : 'Phone call'} recorded`}
            </p>
            <small>
              {timeLabel(activity.occurred_at)}
              {activity.officer_name ? ` · ${activity.officer_name}` : ''}
              {activity.latitude != null
                ? ` · GPS ${Number(activity.latitude).toFixed(4)}, ${Number(activity.longitude).toFixed(4)}`
                : ''}
            </small>
          </div>
        </div>
      ))}
    </div>
  ) : (
    <Empty title="No activity yet">Recorded outcomes will appear here.</Empty>
  );
}

export function LoanDialog({
  loan,
  user,
  language,
  online,
  revision,
  onClose,
  onSave,
  onRefresh,
}: {
  loan: Loan;
  user: User;
  language: Language;
  online: boolean;
  revision: number;
  onClose: () => void;
  onSave: (event: SyncEvent, name: string) => Promise<void>;
  onRefresh: () => void;
}) {
  const { data, error } = useRemote<LoanDetails>(
    `/loans/${loan.id}`,
    online,
    revision,
  );
  const current = data?.loan || loan;
  const isOfficer = user.role === 'field_officer';
  const [tab, setTab] = useState(isOfficer ? 'outcome' : 'history');
  const [outcome, setOutcome] =
    useState<SyncEvent['outcome']>('promise_to_pay');
  const [method, setMethod] = useState<'call' | 'visit'>('visit');
  const [notes, setNotes] = useState('');
  const [amount, setAmount] = useState('');
  const [due, setDue] = useState(today());
  const [gps, setGps] = useState<{
    latitude: number;
    longitude: number;
    location_accuracy_m: number;
  }>();
  const [gpsStatus, setGpsStatus] = useState('Location not captured');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{
    message: string;
    language: string;
    template_id: string;
    draft_hash: string;
  } | null>(null);
  const [draftLanguage, setDraftLanguage] = useState<Language>(language);
  const [reference, setReference] = useState('');
  const paymentRequest = useRef<{ signature: string; id: string } | null>(null);
  const say = (text: string, isError = false) => {
    setMessage(text);
    setFailed(isError);
  };
  const capture = () => {
    if (!navigator.geolocation) {
      setGpsStatus(
        'Location is unavailable on this device. You can still save.',
      );
      return;
    }
    setGpsStatus('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGps({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          location_accuracy_m: position.coords.accuracy,
        });
        setGpsStatus(
          `Location captured · accuracy ${Math.round(position.coords.accuracy)} m`,
        );
      },
      () =>
        setGpsStatus(
          'Location unavailable or permission denied. You can still save.',
        ),
      { timeout: 7000, maximumAge: 60000, enableHighAccuracy: false },
    );
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const update: SyncEvent = {
        id: crypto.randomUUID(),
        loan_id: current.id,
        outcome,
        contact_method: method,
        notes,
        occurred_at: new Date().toISOString(),
        base_promise_id: current.promise?.id || null,
        base_promise_version: current.promise?.version || null,
        ...(method === 'visit' ? gps : {}),
      };
      if (outcome === 'promise_to_pay') {
        update.promised_amount = Number(amount);
        update.due_date = due;
      }
      await onSave(update, current.borrower_name);
      say(
        words(
          language,
          'Saved on this device. Check Activity & sync for the server receipt.',
          'डिवाइस पर सेव हो गया। सर्वर की पुष्टि गतिविधि और सिंक में देखें।',
        ),
      );
      setNotes('');
      setAmount('');
    } catch (err) {
      say(errorMessage(err), true);
    } finally {
      setBusy(false);
    }
  };
  const contact = async (contactMethod: 'call' | 'message') => {
    setBusy(true);
    setMessage('');
    try {
      const result = await post<{ allowed: boolean; reason: string }>(
        `/loans/${current.id}/contact`,
        {
          id: crypto.randomUUID(),
          method: contactMethod,
          language: draftLanguage,
          ...(contactMethod === 'message'
            ? { draft_hash: draft?.draft_hash }
            : {}),
        },
      );
      say(
        result.allowed
          ? `${contactMethod === 'call' ? 'Call' : 'Reminder'} recorded as a demo. No real contact was made.`
          : result.reason,
        !result.allowed,
      );
      onRefresh();
    } catch (err) {
      say(errorMessage(err), true);
    } finally {
      setBusy(false);
    }
  };
  const draftReminder = async () => {
    setBusy(true);
    setMessage('');
    try {
      setDraft(
        await api(`/loans/${current.id}/reminder?language=${draftLanguage}`),
      );
    } catch (err) {
      say(errorMessage(err), true);
    } finally {
      setBusy(false);
    }
  };
  const confirmPayment = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const signature = JSON.stringify([current.id, Number(amount), reference]);
      if (paymentRequest.current?.signature !== signature)
        paymentRequest.current = { signature, id: crypto.randomUUID() };
      await post(`/loans/${current.id}/payment`, {
        id: paymentRequest.current.id,
        amount: Number(amount),
        reference,
      });
      paymentRequest.current = null;
      say('Mock payment confirmed. Balances and promises have been refreshed.');
      setAmount('');
      setReference('');
      onRefresh();
    } catch (err) {
      say(errorMessage(err), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={current.borrower_name} onClose={onClose} wide>
      <div className="loan-detail-top">
        <span>
          {current.external_loan_id} · {current.officer_name || 'Unassigned'}
        </span>
        <StateBadge state={current.state} />
      </div>
      <div className="loan-figures">
        <div>
          <span>Overdue amount</span>
          <strong>{money(current.overdue_amount)}</strong>
        </div>
        <div>
          <span>Days past due</span>
          <strong>
            {current.dpd}
            <small> days</small>
          </strong>
        </div>
        <div>
          <span>Outstanding</span>
          <strong>{money(current.outstanding_amount)}</strong>
        </div>
      </div>
      <div className="detail-reasons">
        <Sparkles size={17} />
        <div>
          <strong>Why it is here</strong>
          {current.reasons.length ? (
            <p>{current.reasons.join(' · ')}</p>
          ) : (
            <p>
              {current.hold_reason ||
                'This case has no current queue position.'}
            </p>
          )}
        </div>
      </div>
      {current.promise && (
        <div className="promise-strip">
          <CalendarDays size={18} />
          <span>
            Promise: <strong>{money(current.promise.promised_amount)}</strong>{' '}
            by <strong>{dateLabel(current.promise.due_date)}</strong>
          </span>
          <Badge>{current.promise.status}</Badge>
        </div>
      )}
      <div className="detail-contact">
        <span>
          <MapPin size={16} />
          {current.address || 'Address not supplied'}
          {current.pincode ? `, ${current.pincode}` : ''}
        </span>
        <div className="button-row">
          {isOfficer && (
            <button
              className="button secondary"
              disabled={!online || !current.phone_number || busy}
              onClick={() => void contact('call')}
            >
              <Phone size={15} />
              {words(language, 'Mock call', 'डेमो कॉल')}
            </button>
          )}
          {current.address ? (
            <a
              className="button secondary"
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${current.address} ${current.pincode || ''}`)}`}
              target="_blank"
              rel="noreferrer"
            >
              <MapPin size={15} />
              {words(language, 'Map', 'नक्शा')}
            </a>
          ) : (
            <button className="button secondary" disabled>
              <MapPin size={15} />
              Map
            </button>
          )}
        </div>
      </div>
      <p className="footnote">
        {words(
          language,
          'Calls and messages require a connection and are allowed 08:00–19:00 IST. All contact is simulated.',
          'कॉल और संदेश के लिए इंटरनेट चाहिए। समय: सुबह 8 से शाम 7 बजे (IST)। यह केवल डेमो है।',
        )}{' '}
        · Data: {dateLabel(current.report_date)}
      </p>
      {message && (
        <Notice kind={failed ? 'error' : 'success'}>{message}</Notice>
      )}
      {error && online && (
        <Notice kind="error">Could not refresh details: {error}</Notice>
      )}
      <div className="tabs detail-tabs">
        {[
          ...(isOfficer
            ? [
                ['outcome', words(language, 'Log outcome', 'नतीजा दर्ज करें')],
                ['reminder', words(language, 'Reminder', 'रिमाइंडर')],
              ]
            : []),
          ['history', words(language, 'History', 'इतिहास')],
          ...(user.role === 'branch_manager'
            ? [['payment', 'Mock payment']]
            : []),
        ].map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? 'active' : ''}
            onClick={() => {
              setTab(key);
              setMessage('');
              setAmount('');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {isOfficer && tab === 'outcome' && (
        <form onSubmit={submit} className="detail-form">
          <fieldset>
            <legend>{words(language, 'What happened?', 'क्या हुआ?')}</legend>
            <div className="outcome-options">
              {(
                [
                  ['promise_to_pay', 'Promise to pay', 'भुगतान का वादा'],
                  ['paid_reported', 'Payment reported', 'भुगतान की सूचना'],
                  ['not_reachable', 'Not reachable', 'संपर्क नहीं हुआ'],
                  ['dispute', 'Dispute', 'विवाद'],
                ] as const
              ).map(([value, en, hi]) => (
                <label
                  key={value}
                  className={outcome === value ? 'selected' : ''}
                >
                  <input
                    type="radio"
                    name="outcome"
                    checked={outcome === value}
                    onChange={() => setOutcome(value)}
                  />
                  {words(language, en, hi)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="form-row">
            <label>
              {words(language, 'Contact method', 'संपर्क का तरीका')}
              <select
                value={method}
                onChange={(event) =>
                  setMethod(event.target.value as 'call' | 'visit')
                }
              >
                <option value="visit">
                  {words(language, 'Field visit', 'फ़ील्ड विज़िट')}
                </option>
                <option value="call">
                  {words(language, 'Phone call', 'फ़ोन कॉल')}
                </option>
              </select>
            </label>
            {outcome === 'promise_to_pay' && (
              <>
                <label>
                  {words(
                    language,
                    'Promised amount (₹)',
                    'वादा की गई राशि (₹)',
                  )}
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    required
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="5000"
                  />
                </label>
                <label>
                  {words(language, 'Promised date', 'वादा की तारीख')}
                  <input
                    type="date"
                    required
                    min={today()}
                    value={due}
                    onChange={(event) => setDue(event.target.value)}
                  />
                </label>
              </>
            )}
          </div>
          <label>
            {words(language, 'Notes', 'नोट्स')}
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              required={outcome === 'dispute'}
              maxLength={500}
              rows={3}
              placeholder={words(
                language,
                'A short note for the next follow-up…',
                'अगले फ़ॉलो-अप के लिए छोटा सा नोट…',
              )}
            />
          </label>
          {outcome === 'paid_reported' && (
            <Notice>
              A reported payment does not clear the overdue balance. It waits
              for a confirmed payment record.
            </Notice>
          )}
          {method === 'visit' && (
            <div className="gps-row">
              <span>
                <LocateFixed size={16} />
                {gpsStatus}
              </span>
              <button type="button" className="text-link" onClick={capture}>
                {words(language, 'Capture GPS', 'लोकेशन लें')}
              </button>
            </div>
          )}
          <button className="button primary full" disabled={busy}>
            <ClipboardCheck size={18} />
            {busy
              ? words(language, 'Saving…', 'सेव हो रहा है…')
              : words(language, 'Save outcome', 'नतीजा सेव करें')}
          </button>
          <p className="footnote center">
            {words(
              language,
              'Saved on your device first, then synced with the branch.',
              'पहले डिवाइस पर सेव होगा, फिर ब्रांच के साथ सिंक होगा।',
            )}
          </p>
        </form>
      )}
      {isOfficer && tab === 'reminder' && (
        <div className="detail-form">
          <p>
            Use the approved wording. Preview it before recording a simulated
            send.
          </p>
          <div className="button-row">
            <select
              aria-label="Reminder language"
              value={draftLanguage}
              onChange={(event) => {
                setDraftLanguage(event.target.value as Language);
                setDraft(null);
              }}
            >
              <option value="hi">हिन्दी</option>
              <option value="en">English</option>
            </select>
            <button
              className="button secondary"
              disabled={!online || busy}
              onClick={() => void draftReminder()}
            >
              <MessageSquare size={16} />
              Prepare reminder
            </button>
          </div>
          {draft && (
            <>
              <blockquote className="message-preview">
                {draft.message}
              </blockquote>
              <p className="footnote">
                <ShieldCheck size={14} />
                Approved template · {draft.template_id}
              </p>
              <button
                className="button primary"
                disabled={!online || busy || !current.phone_number}
                onClick={() => void contact('message')}
              >
                Review complete · Mock send
                <ArrowRight size={16} />
              </button>
            </>
          )}
          {!online && (
            <Notice>
              Reconnect to prepare or send a reminder. Outcome logging still
              works offline.
            </Notice>
          )}
        </div>
      )}
      {tab === 'history' && (
        <div className="detail-form">
          <h3>Officer activity</h3>
          <ActivityList activities={data?.activities || []} />
          <h3>Confirmed payments</h3>
          {data?.payments.length ? (
            data.payments.map((payment) => (
              <div className="history-line" key={payment.id}>
                <span>
                  {payment.reference}
                  <small>{timeLabel(payment.occurred_at)}</small>
                </span>
                <strong>{money(payment.amount)}</strong>
              </div>
            ))
          ) : (
            <p className="muted">No confirmed payments available.</p>
          )}
          <h3>Contact attempts</h3>
          {data?.contacts.length ? (
            data.contacts.map((contact) => (
              <div className="history-line" key={contact.id}>
                <span>
                  {contact.method}
                  <small>
                    {timeLabel(contact.occurred_at)} · {contact.reason}
                  </small>
                </span>
                <Badge tone={contact.allowed ? 'green' : 'amber'}>
                  {contact.allowed ? 'Simulated' : 'Blocked'}
                </Badge>
              </div>
            ))
          ) : (
            <p className="muted">No contact attempts available.</p>
          )}
          {!online && (
            <Notice>
              Full activity history is available when you reconnect.
            </Notice>
          )}
        </div>
      )}
      {tab === 'payment' && (
        <form className="detail-form" onSubmit={confirmPayment}>
          <Notice>
            This simulates confirmation from an external payment system. No
            money is collected here.
          </Notice>
          <div className="form-row">
            <label>
              Received amount (₹)
              <input
                type="number"
                min="1"
                step="0.01"
                max={current.outstanding_amount}
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label>
              Payment reference
              <input
                required
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="DEMO-PAY-001"
              />
            </label>
          </div>
          <button className="button primary" disabled={!online || busy}>
            <CheckCircle2 size={16} />
            Confirm mock payment
          </button>
        </form>
      )}
    </Modal>
  );
}

export function Promises({
  loans,
  language,
  online,
  revision,
  onOpen,
}: {
  loans: Loan[];
  language: Language;
  online: boolean;
  revision: number;
  onOpen: (loan: Loan) => void;
}) {
  const { data, loading, error } = useRemote<{ promises: PromiseItem[] }>(
    '/promises',
    online,
    revision,
  );
  const list: PromiseItem[] =
    online && data
      ? data.promises
      : loans.flatMap((loan) =>
          loan.promise
            ? [
                {
                  ...loan.promise,
                  borrower_name: loan.borrower_name,
                  external_loan_id: loan.external_loan_id,
                  officer_name: loan.officer_name || '',
                },
              ]
            : [],
        );
  return (
    <>
      <SectionTitle
        eyebrow={words(
          language,
          'KEEP THE NEXT STEP CLEAR',
          'अगला कदम याद रखें',
        )}
        title={words(language, 'Promises to keep.', 'भुगतान के वादे।')}
        description={words(
          language,
          'A date, an amount, and a follow-up that does not get lost.',
          'तारीख, राशि और अगला फ़ॉलो-अप एक जगह।',
        )}
      />
      {error && online && <Notice kind="error">{error}</Notice>}
      <section className="panel">
        <PanelHeading
          title={words(language, 'Promise tracker', 'वादों का ट्रैकर')}
          meta={`${list.length} ${words(language, 'promises', 'वादे')}`}
        />
        {loading && !data ? (
          <Loading />
        ) : list.length ? (
          <div className="promise-list">
            {list.map((promise) => (
              <div className="promise-row" key={promise.id}>
                <div className="calendar-tile">
                  <strong>
                    {new Date(`${promise.due_date}T12:00:00`).getDate()}
                  </strong>
                  <span>
                    {new Date(
                      `${promise.due_date}T12:00:00`,
                    ).toLocaleDateString('en-IN', { month: 'short' })}
                  </span>
                </div>
                <div className="grow">
                  <strong>{promise.borrower_name}</strong>
                  <small>
                    {promise.external_loan_id} · {promise.officer_name}
                  </small>
                </div>
                <strong>{money(promise.promised_amount)}</strong>
                <Badge
                  tone={
                    promise.status === 'broken'
                      ? 'amber'
                      : promise.status === 'kept'
                        ? 'green'
                        : 'neutral'
                  }
                >
                  {promise.status}
                </Badge>
                <button
                  className="icon-button"
                  aria-label={`Open ${promise.borrower_name}`}
                  disabled={!loans.some((loan) => loan.id === promise.loan_id)}
                  onClick={() => {
                    const loan = loans.find(
                      (item) => item.id === promise.loan_id,
                    );
                    if (loan) onOpen(loan);
                  }}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title={words(
              language,
              'No promises recorded yet',
              'अभी कोई वादा दर्ज नहीं है',
            )}
          >
            {words(
              language,
              'Log a promise from a loan to track its amount and due date here.',
              'किसी लोन में वादा दर्ज करें। उसकी राशि और तारीख यहाँ दिखेगी।',
            )}
          </Empty>
        )}
      </section>
    </>
  );
}

export function DeviceActivity({
  outbox,
  language,
  onSync,
  syncing,
  online,
}: {
  outbox: OutboxEntry[];
  language: Language;
  onSync: () => void;
  syncing: boolean;
  online: boolean;
}) {
  const statusLabels: Record<OutboxEntry['status'], string> = {
    pending: words(
      language,
      'Saved on device · pending sync',
      'डिवाइस पर सेव · सिंक बाकी',
    ),
    applied: words(language, 'Synced', 'सिंक हो गया'),
    needs_review: words(
      language,
      'Uploaded · manager review',
      'अपलोड हुआ · मैनेजर समीक्षा',
    ),
    rejected: words(
      language,
      'Not applied · needs attention',
      'लागू नहीं हुआ · ध्यान दें',
    ),
  };
  return (
    <>
      <SectionTitle
        eyebrow={words(
          language,
          'NOTHING LOST IN THE FIELD',
          'हर अपडेट सुरक्षित',
        )}
        title={words(language, 'Activity & sync.', 'गतिविधि और सिंक।')}
        description={words(
          language,
          'Your saved updates and their server receipts, on this device.',
          'इस डिवाइस के अपडेट और सर्वर की पुष्टि।',
        )}
        action={
          <button
            className="button primary"
            disabled={!online || syncing}
            onClick={onSync}
          >
            <Upload size={17} />
            {syncing
              ? 'Syncing…'
              : words(language, 'Sync now', 'अभी सिंक करें')}
          </button>
        }
      />
      <section className="panel">
        <PanelHeading
          title={words(language, 'Device activity', 'डिवाइस की गतिविधि')}
          meta={words(
            language,
            'An uploaded update may still need manager review.',
            'अपलोड होने के बाद भी मैनेजर की समीक्षा ज़रूरी हो सकती है।',
          )}
        />
        {outbox.length ? (
          <div className="device-list">
            {[...outbox]
              .sort((a, b) =>
                b.event.occurred_at.localeCompare(a.event.occurred_at),
              )
              .map((entry) => (
                <div className="device-row" key={entry.id}>
                  <span className={`device-status-icon ${entry.status}`}>
                    {entry.status === 'applied' ? (
                      <CheckCircle2 size={20} />
                    ) : entry.status === 'pending' ? (
                      <CloudOff size={20} />
                    ) : (
                      <ClipboardCheck size={20} />
                    )}
                  </span>
                  <div className="grow">
                    <strong>{entry.borrower_name}</strong>
                    <p>
                      {outcomeLabels[entry.event.outcome]} ·{' '}
                      {entry.event.contact_method}
                    </p>
                    <small>{timeLabel(entry.event.occurred_at)}</small>
                    {entry.error && (
                      <p className="error-text">
                        {entry.error} Open the case, refresh its details, and
                        record a corrected update.
                      </p>
                    )}
                  </div>
                  <Badge
                    tone={
                      entry.status === 'applied'
                        ? 'green'
                        : entry.status === 'rejected'
                          ? 'red'
                          : 'amber'
                    }
                  >
                    {statusLabels[entry.status]}
                  </Badge>
                </div>
              ))}
          </div>
        ) : (
          <Empty
            title={words(
              language,
              'Your notebook is ready',
              'आपकी नोटबुक तैयार है',
            )}
          >
            {words(
              language,
              'Outcomes you record on this device will appear here, even offline.',
              'इस डिवाइस पर दर्ज नतीजे यहाँ दिखेंगे, ऑफलाइन भी।',
            )}
          </Empty>
        )}
      </section>
    </>
  );
}

export function Imports({
  loans,
  online,
  revision,
  onRefresh,
  onOpenAssign,
}: {
  loans: Loan[];
  online: boolean;
  revision: number;
  onRefresh: () => void;
  onOpenAssign: () => void;
}) {
  const { data, error } = useRemote<{ imports: ImportBatch[] }>(
    '/imports',
    online,
    revision,
  );
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [reportDate, setReportDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [failure, setFailure] = useState('');
  const upload = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setResult('');
    setFailure('');
    const validation = importValidationError(csv, reportDate);
    if (validation) {
      setFailure(validation);
      setBusy(false);
      return;
    }
    try {
      const response = await post<{
        row_count: number;
        created: number;
        updated: number;
      }>('/imports', { csv, report_date: reportDate });
      setResult(
        `${response.row_count} rows processed: ${response.created} new cases and ${response.updated} updates. Existing assignments and history are preserved.`,
      );
      onRefresh();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionTitle
        eyebrow="DAILY INTAKE"
        title="Fresh data. Familiar cases."
        description="Import the day's overdue loans. We keep existing assignments and history."
        action={
          <button className="button secondary" onClick={onOpenAssign}>
            <Users size={17} />
            Manage assignments
          </button>
        }
      />
      <div className="import-grid">
        <section className="panel">
          <PanelHeading
            title="Import overdue loans"
            meta="CSV · one row per loan"
          />
          <form onSubmit={upload} className="import-form">
            <label className="upload-zone">
              <span className="upload-icon">
                <FileUp size={29} />
              </span>
              <strong>{fileName || 'Choose an overdue-loans CSV'}</strong>
              <span>
                {fileName
                  ? 'Click to choose a different file'
                  : 'Select a file from your computer'}
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="Choose CSV file"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 1_000_000) {
                    setFailure('Use a CSV smaller than 1 MB.');
                    return;
                  }
                  setFileName(file.name);
                  setCsv(await file.text());
                  setFailure('');
                }}
              />
            </label>
            <label>
              Report date
              <input
                type="date"
                value={reportDate}
                max={today()}
                required
                onChange={(event) => setReportDate(event.target.value)}
              />
              <small>
                The date these balances describe, even if you upload the file
                later.
              </small>
            </label>
            <p className="footnote">
              Every row is validated before changes are applied. New cases are
              assigned by pincode and workload.
            </p>
            {result && <Notice kind="success">{result}</Notice>}
            {failure && <Notice kind="error">{failure}</Notice>}
            <button
              className="button primary full"
              disabled={!csv || !online || busy}
            >
              <Upload size={17} />
              {busy ? 'Validating and importing…' : 'Validate & import'}
            </button>
          </form>
        </section>
        <aside className="import-aside">
          <span className="eyebrow">BEFORE YOU IMPORT</span>
          <h2>One case, all its context.</h2>
          <ol className="steps">
            <li>
              <strong>Match by loan ID</strong>
              <p>
                Existing cases receive fresh figures without losing field notes.
              </p>
            </li>
            <li>
              <strong>Keep the same officer</strong>
              <p>Only a manager reassignment changes ownership.</p>
            </li>
            <li>
              <strong>Missing does not mean cleared</strong>
              <p>
                A loan absent from today's file remains visible with its last
                report date.
              </p>
            </li>
          </ol>
          <a href="/sample-import.csv" download className="button secondary">
            <Download size={16} />
            Download sample CSV
          </a>
          <p className="footnote">
            Synthetic demo data only. Use your branch code.
          </p>
          <div className="unassigned-note">
            <Users size={20} />
            <span>
              <strong>
                {loans.filter((loan) => !loan.assigned_officer_id).length}
              </strong>{' '}
              cases need an officer
            </span>
          </div>
        </aside>
      </div>
      <section className="panel">
        <PanelHeading
          title="Import history"
          meta="Each upload has its own receipt"
        />
        {error && <Notice kind="error">{error}</Notice>}
        {data?.imports.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Report date</th>
                  <th>Uploaded</th>
                  <th>Rows</th>
                  <th>Status</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {data.imports.map((batch) => (
                  <tr key={batch.id}>
                    <td>{dateLabel(batch.report_date)}</td>
                    <td>{timeLabel(batch.created_at)}</td>
                    <td>{batch.row_count}</td>
                    <td>
                      <Badge>{batch.status}</Badge>
                    </td>
                    <td>
                      {batch.error ||
                        `${batch.created ?? 0} new · ${batch.updated ?? 0} updated`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No imports yet">
            Choose a CSV above to start your daily intake.
          </Empty>
        )}
      </section>
    </>
  );
}

export function AssignmentDialog({
  loans,
  online,
  onClose,
  onRefresh,
}: {
  loans: Loan[];
  online: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { data, error } = useRemote<{ officers: User[] }>('/officers', online);
  const [loanId, setLoanId] = useState(
    loans.find((loan) => !loan.assigned_officer_id)?.id || loans[0]?.id || '',
  );
  const [officerId, setOfficerId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setFailure('');
    try {
      await post(`/loans/${loanId}/assign`, { officer_id: officerId, reason });
      setMessage(
        'Assignment updated. Previous ownership remains in the case history.',
      );
      onRefresh();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Assign a case" onClose={onClose}>
      <form className="detail-form" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        <label>
          Case
          <select
            required
            value={loanId}
            onChange={(event) => setLoanId(event.target.value)}
          >
            {loans.map((loan) => (
              <option key={loan.id} value={loan.id}>
                {loan.borrower_name} · {loan.external_loan_id} ·{' '}
                {loan.officer_name || 'Unassigned'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assign to
          <select
            required
            value={officerId}
            onChange={(event) => setOfficerId(event.target.value)}
          >
            <option value="">Choose an officer</option>
            {data?.officers.map((officer) => (
              <option key={officer.id} value={officer.id}>
                {officer.full_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reason
          <textarea
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this assignment changing?"
            rows={3}
          />
        </label>
        {message && <Notice kind="success">{message}</Notice>}
        {failure && <Notice kind="error">{failure}</Notice>}
        <button
          className="button primary full"
          disabled={busy || !online || !loanId}
        >
          Save assignment
        </button>
      </form>
    </Modal>
  );
}

export function ReorderDialog({
  loans,
  online,
  onClose,
  onRefresh,
}: {
  loans: Loan[];
  online: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const officers = [
    ...new Map(
      loans
        .filter((loan) => loan.assigned_officer_id)
        .map((loan) => [
          loan.assigned_officer_id!,
          loan.officer_name || 'Officer',
        ]),
    ).entries(),
  ];
  const [officer, setOfficer] = useState(officers[0]?.[0] || '');
  const [order, setOrder] = useState(
    loans.filter(
      (loan) => loan.assigned_officer_id === officer && loan.state === 'ready',
    ),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const move = (index: number, direction: number) =>
    setOrder((previous) => {
      const next = [...previous];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      return next;
    });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/priority/override', {
        officer_id: officer,
        loan_ids: order.map((loan) => loan.id),
        reason,
      });
      onRefresh();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Reorder today's cases" onClose={onClose}>
      <form className="detail-form" onSubmit={submit}>
        <Notice>
          The suggested scores stay in history. Your order is recorded as a
          manager override.
        </Notice>
        <label>
          Officer
          <select
            value={officer}
            onChange={(event) => {
              setOfficer(event.target.value);
              setOrder(
                loans.filter(
                  (loan) =>
                    loan.assigned_officer_id === event.target.value &&
                    loan.state === 'ready',
                ),
              );
            }}
          >
            {officers.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="reorder-list">
          {order.map((loan, index) => (
            <div className="reorder-row" key={loan.id}>
              <span className="case-index">{index + 1}</span>
              <div className="grow">
                <strong>{loan.borrower_name}</strong>
                <small>
                  {loan.dpd} DPD · {money(loan.overdue_amount)}
                </small>
              </div>
              <button
                type="button"
                className="icon-button"
                disabled={index === 0}
                aria-label={`Move ${loan.borrower_name} up`}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={index === order.length - 1}
                aria-label={`Move ${loan.borrower_name} down`}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={16} />
              </button>
            </div>
          ))}
        </div>
        {!order.length && <p>No ready cases for this officer.</p>}
        <label>
          Reason for override
          <textarea
            rows={2}
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        <button
          className="button primary full"
          disabled={!online || busy || !order.length}
        >
          Save manager order
        </button>
      </form>
    </Modal>
  );
}

export function Review({
  online,
  revision,
  onRefresh,
}: {
  online: boolean;
  revision: number;
  onRefresh: () => void;
}) {
  const conflicts = useRemote<{ conflicts: Conflict[] }>(
    '/conflicts',
    online,
    revision,
  );
  const weeks = useRemote<{ weeks: Week[] }>(
    '/weekly-review',
    online,
    revision,
  );
  const [tab, setTab] = useState('conflicts');
  const [selected, setSelected] = useState<Conflict | null>(null);
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState<
    'keep_current' | 'accept_incoming'
  >('keep_current');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const resolve = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await post(`/conflicts/${selected.id}/resolve`, {
        resolution,
        note,
        current_promise_id: selected.current_promise_id,
        current_promise_version: selected.current_promise_version,
      });
      setSelected(null);
      setNote('');
      onRefresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionTitle
        eyebrow="HUMAN JUDGMENT, IN THE LOOP"
        title="Review what matters."
        description="Resolve conflicting updates and see how priorities compared with payments."
      />
      <div className="tabs standalone-tabs">
        <button
          className={tab === 'conflicts' ? 'active' : ''}
          onClick={() => setTab('conflicts')}
        >
          Updates to review{' '}
          <span className="tab-count">
            {conflicts.data?.conflicts.length ?? '—'}
          </span>
        </button>
        <button
          className={tab === 'weekly' ? 'active' : ''}
          onClick={() => setTab('weekly')}
        >
          Weekly score review
        </button>
      </div>
      {!online && <Notice>Connect to load and resolve manager reviews.</Notice>}
      {tab === 'conflicts' ? (
        <section className="panel">
          <PanelHeading
            title="Conflicting promises"
            meta="Both versions are preserved until you make a decision"
          />
          {conflicts.error && <Notice kind="error">{conflicts.error}</Notice>}
          {conflicts.loading ? (
            <Loading />
          ) : conflicts.data?.conflicts.length ? (
            conflicts.data.conflicts.map((conflict) => (
              <div className="conflict-row" key={conflict.id}>
                <span className="review-symbol">
                  <ClipboardCheck size={22} />
                </span>
                <div className="grow">
                  <strong>{conflict.borrower_name}</strong>
                  <p>
                    {conflict.reason ||
                      'An offline update was based on an older promise.'}
                  </p>
                  <small>
                    {conflict.external_loan_id} · {conflict.officer_name} ·{' '}
                    {timeLabel(conflict.created_at)}
                  </small>
                </div>
                <button
                  className="button secondary"
                  onClick={() => {
                    setSelected(conflict);
                    setError('');
                    setResolution('keep_current');
                  }}
                >
                  Compare updates
                  <ArrowRight size={16} />
                </button>
              </div>
            ))
          ) : (
            <Empty title="Nothing waiting for a decision">
              If an offline update conflicts with a newer promise, both will
              appear here.
            </Empty>
          )}
        </section>
      ) : (
        <>
          {weeks.error && <Notice kind="error">{weeks.error}</Notice>}
          {weeks.loading ? (
            <Loading />
          ) : weeks.data?.weeks.length ? (
            weeks.data.weeks.map((week) => (
              <section className="panel weekly-panel" key={week.id}>
                <PanelHeading
                  title={week.label}
                  meta={`${dateLabel(week.start_date)} – ${dateLabel(week.end_date)}`}
                  action={
                    <div className="button-row">
                      {week.synthetic && (
                        <Badge tone="amber">Synthetic demo week</Badge>
                      )}
                      <Badge
                        tone={week.status === 'completed' ? 'green' : 'neutral'}
                      >
                        {week.status}
                      </Badge>
                    </div>
                  }
                />
                <p className="weekly-explanation">
                  Scores saved at the beginning of the week, compared with
                  confirmed payments afterward. This is a review of results, not
                  proof that the order caused repayment.
                </p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Priority group</th>
                        <th>Loans</th>
                        <th>With payments</th>
                        <th>Amount collected</th>
                      </tr>
                    </thead>
                    <tbody>
                      {week.groups.map((group) => (
                        <tr key={group.label}>
                          <td>
                            <strong>{group.label}</strong>
                          </td>
                          <td>{group.count}</td>
                          <td>{group.paid_count}</td>
                          <td>{money(group.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details className="week-detail">
                  <summary>See original scores and payment outcomes</summary>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Borrower</th>
                          <th>Original score</th>
                          <th>Payment</th>
                          <th>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {week.loans.map((loan) => (
                          <tr key={loan.external_loan_id}>
                            <td>
                              {loan.borrower_name}
                              <small>{loan.external_loan_id}</small>
                            </td>
                            <td>{loan.score}</td>
                            <td>
                              {loan.paid ? 'Recorded' : 'No payment recorded'}
                            </td>
                            <td>{money(loan.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </section>
            ))
          ) : (
            <Empty title="No completed weeks yet">
              A weekly review appears once score history and payment outcomes
              are available.
            </Empty>
          )}
        </>
      )}
      {selected && (
        <Modal
          title={`Review ${selected.borrower_name}`}
          onClose={() => setSelected(null)}
          wide
        >
          <form className="detail-form" onSubmit={resolve}>
            <p>
              Choose which promise should remain active. Both original
              submissions stay in history.
            </p>
            <div className="comparison">
              <label
                className={resolution === 'keep_current' ? 'selected' : ''}
              >
                <span>
                  <input
                    type="radio"
                    name="resolution"
                    checked={resolution === 'keep_current'}
                    onChange={() => setResolution('keep_current')}
                  />
                  Keep current promise
                </span>
                <strong>
                  {selected.current_promise
                    ? money(selected.current_promise.promised_amount)
                    : 'No active promise'}
                </strong>
                <p>Due {dateLabel(selected.current_promise?.due_date)}</p>
                <small>
                  Version {selected.current_promise_version ?? 'none'} when
                  conflict was found
                </small>
              </label>
              <label
                className={resolution === 'accept_incoming' ? 'selected' : ''}
              >
                <span>
                  <input
                    type="radio"
                    name="resolution"
                    checked={resolution === 'accept_incoming'}
                    onChange={() => setResolution('accept_incoming')}
                  />
                  Accept offline update
                </span>
                <strong>
                  {selected.incoming.promised_amount !== undefined
                    ? money(selected.incoming.promised_amount)
                    : 'Amount not supplied'}
                </strong>
                <p>Due {dateLabel(selected.incoming.due_date)}</p>
                <small>
                  {selected.incoming.notes ||
                    `Submitted by ${selected.officer_name}`}
                </small>
              </label>
            </div>
            <label>
              Decision note
              <textarea
                required
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Record why you chose this version."
              />
            </label>
            {error && (
              <Notice kind="error">
                {error} Close this review and refresh to check whether the
                promise changed again.
              </Notice>
            )}
            <button className="button primary full" disabled={busy || !online}>
              Resolve and keep both originals
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
