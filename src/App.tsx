import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CalendarCheck2,
  Check,
  ChevronRight,
  ClipboardList,
  Cloud,
  CloudOff,
  FileUp,
  Languages,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { Loan, SyncEvent, User } from '../shared/types';
import { api, ApiError, errorMessage, post, timeLabel } from './api';
import {
  cachedCases,
  cacheCases,
  clearUser,
  entries,
  putEntry,
  rememberIdentity,
  savedIdentity,
  type OutboxEntry,
} from './offline';
import { Brand, Loading, Notice } from './ui';
import { uploadSnapshot, type SyncResult } from './sync';
import {
  AssignmentDialog,
  DeviceActivity,
  Imports,
  LoanDialog,
  Overview,
  Promises,
  ReorderDialog,
  Review,
  Worklist,
  words,
  type Language,
} from './views';

type View =
  | 'overview'
  | 'work'
  | 'promises'
  | 'activity'
  | 'imports'
  | 'review';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [view, setView] = useState<View>('work');
  const [language, setLanguage] = useState<Language>(
    (localStorage.getItem('fieldnote-language') as Language) || 'en',
  );
  const [error, setError] = useState('');
  const [cacheTime, setCacheTime] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'assign' | 'reorder' | null>(null);
  const userRef = useRef<User | null>(null);
  const sessionGeneration = useRef(0);
  const syncingRef = useRef(false);
  const flushRequested = useRef(false);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const flushRef = useRef<() => Promise<void>>(async () => {});

  const refresh = useCallback(async () => {
    const account = userRef.current;
    const generation = sessionGeneration.current;
    if (!account || !navigator.onLine) return;
    const stillCurrent = () =>
      userRef.current?.id === account.id &&
      sessionGeneration.current === generation;
    setRefreshing(true);
    try {
      const response = await api<{
        loans: Loan[];
        user: User;
        serverTime: string;
      }>('/loans');
      if (!stillCurrent()) return;
      if (response.user.id !== account.id) {
        setAuthRequired(true);
        return;
      }
      setLoans(response.loans);
      await cacheCases(account.id, response.loans);
      if (!stillCurrent()) return;
      setCacheTime(new Date().toISOString());
      setRevision((previous) => previous + 1);
      setError('');
    } catch (err) {
      if (!stillCurrent()) return;
      if (err instanceof ApiError && err.status === 401) setAuthRequired(true);
      else setError(`Could not refresh cases. ${errorMessage(err)}`);
    } finally {
      if (stillCurrent()) setRefreshing(false);
    }
  }, []);

  const activate = useCallback(async (account: User) => {
    const generation = ++sessionGeneration.current;
    userRef.current = account;
    setUser(account);
    setAuthRequired(false);
    setLoans([]);
    setOutbox([]);
    setSelected(null);
    const [cache, saved] = await Promise.all([
      cachedCases(account.id),
      entries(account.id),
    ]);
    if (
      userRef.current?.id !== account.id ||
      generation !== sessionGeneration.current
    )
      return;
    await rememberIdentity(account);
    if (
      userRef.current?.id !== account.id ||
      generation !== sessionGeneration.current
    )
      return;
    setLoans(cache?.loans || []);
    setCacheTime(cache?.saved_at || '');
    setOutbox(saved);
    setView(account.role === 'branch_manager' ? 'overview' : 'work');
    if (!localStorage.getItem('fieldnote-language'))
      setLanguage(account.role === 'field_officer' ? 'hi' : 'en');
  }, []);

  const flush = useCallback(async () => {
    const account = userRef.current;
    const generation = sessionGeneration.current;
    if (!account || !navigator.onLine) return;
    if (syncingRef.current) {
      flushRequested.current = true;
      return;
    }
    syncingRef.current = true;
    flushRequested.current = false;
    let completed = false;
    setSyncing(true);
    const stillCurrent = () =>
      userRef.current?.id === account.id &&
      sessionGeneration.current === generation;
    try {
      const queued = (await entries(account.id)).filter(
        (entry) => entry.status === 'pending',
      );
      if (!stillCurrent()) return;
      if (!queued.length) {
        completed = true;
        return;
      }
      const session = await api<{ user: User }>('/auth/me');
      if (!stillCurrent()) return;
      if (session.user.id !== account.id) {
        setAuthRequired(true);
        return;
      }
      const result = await uploadSnapshot(
        queued,
        async (batch) => {
          if (!stillCurrent()) throw new Error('Account changed during sync.');
          const response = await post<{ results: SyncResult[] }>('/sync', {
            events: batch,
          });
          if (!stillCurrent()) throw new Error('Account changed during sync.');
          return response;
        },
        async (entry) => {
          if (!stillCurrent()) throw new Error('Account changed during sync.');
          await putEntry(entry);
          if (!stillCurrent()) return;
          const saved = await entries(account.id);
          if (stillCurrent()) setOutbox(saved);
        },
      );
      if (!stillCurrent()) return;
      retryCount.current = 0;
      await refresh();
      if (!stillCurrent()) return;
      completed = result.unacknowledged === 0;
      if (!completed)
        setError(
          'Some updates did not receive a server receipt. They remain pending; use Sync now to retry.',
        );
    } catch (err) {
      if (!stillCurrent()) return;
      if (err instanceof ApiError && err.status === 401) setAuthRequired(true);
      else {
        setError(
          `Updates are safe on this device. Sync could not finish: ${errorMessage(err)}`,
        );
        if (!(err instanceof ApiError) || err.status >= 500) {
          retryCount.current += 1;
          if (retryCount.current <= 6) {
            if (retryRef.current) clearTimeout(retryRef.current);
            retryRef.current = setTimeout(
              () => {
                void flushRef.current();
              },
              Math.min(60000, 3000 * 2 ** (retryCount.current - 1)),
            );
          }
        }
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      if (
        (completed || !stillCurrent()) &&
        flushRequested.current &&
        userRef.current
      ) {
        flushRequested.current = false;
        if (retryRef.current) clearTimeout(retryRef.current);
        retryRef.current = setTimeout(() => {
          void flushRef.current();
        }, 100);
      }
    }
  }, [refresh]);
  flushRef.current = flush;

  useEffect(() => {
    let mounted = true;
    const start = async () => {
      try {
        const response = await api<{ user: User }>('/auth/me');
        if (!mounted) return;
        await activate(response.user);
        await refresh();
        await flush();
      } catch (err) {
        if (!(err instanceof ApiError)) {
          try {
            const identity = await savedIdentity();
            if (identity && mounted) {
              await activate(identity);
              setOnline(false);
            }
          } catch {
            if (mounted)
              setError(
                'Device storage is unavailable. Connect and sign in to continue.',
              );
          }
        }
      } finally {
        if (mounted) setBooting(false);
      }
    };
    void start();
    const onOnline = () => {
      setOnline(true);
      void flush();
      void refresh();
    };
    const onOffline = () => setOnline(false);
    const onFocus = () => {
      if (navigator.onLine) {
        setOnline(true);
        void flush();
        void refresh();
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onFocus);
    return () => {
      mounted = false;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onFocus);
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [activate, flush, refresh]);

  useEffect(() => {
    document.documentElement.lang =
      language === 'hi' && user?.role === 'field_officer' ? 'hi' : 'en';
  }, [language, user]);

  const login = async (email: string, password: string) => {
    const response = await post<{ user: User }>('/auth/login', {
      email,
      password,
    });
    if (authRequired && user && response.user.id !== user.id) {
      await post('/auth/logout');
      throw new Error(
        `Sign back in as ${user.email} to sync this device's pending updates.`,
      );
    }
    await activate(response.user);
    setOnline(true);
    await refresh();
    await flush();
  };
  const logout = async () => {
    if (!user) return;
    const account = user;
    const generation = sessionGeneration.current;
    const pending = outbox.filter((entry) => entry.status === 'pending');
    if (
      pending.length &&
      !window.confirm(
        `${pending.length} updates are still only on this device. Signing out deletes them. Cancel to sync first, or OK to discard and sign out.`,
      )
    )
      return;
    if (navigator.onLine) {
      try {
        await post('/auth/logout');
      } catch (err) {
        setError(`Sign-out was not confirmed. ${errorMessage(err)}`);
        return;
      }
    } else {
      setError(
        'Reconnect to sign out securely and clear this device. Your saved work stays available until then.',
      );
      return;
    }
    if (
      userRef.current?.id !== account.id ||
      sessionGeneration.current !== generation
    )
      return;
    userRef.current = null;
    sessionGeneration.current += 1;
    if (retryRef.current) clearTimeout(retryRef.current);
    await clearUser(account.id);
    setUser(null);
    setLoans([]);
    setOutbox([]);
    setSelected(null);
    setAuthRequired(false);
    setError('');
    setCacheTime('');
  };
  const save = async (event: SyncEvent, borrowerName: string) => {
    if (!user) throw new Error('Sign in before saving an outcome.');
    if (userRef.current?.id !== user.id)
      throw new Error('Your account changed. Sign in again before saving.');
    if (user.role !== 'field_officer')
      throw new Error('Only the assigned field officer can record an outcome.');
    const generation = sessionGeneration.current;
    await putEntry({
      id: event.id,
      user_id: user.id,
      borrower_name: borrowerName,
      event,
      status: 'pending',
    });
    if (
      userRef.current?.id !== user.id ||
      generation !== sessionGeneration.current
    )
      return;
    const saved = await entries(user.id);
    if (
      userRef.current?.id !== user.id ||
      generation !== sessionGeneration.current
    )
      return;
    setOutbox(saved);
    void flush();
  };
  const toggleLanguage = () => {
    const next = language === 'en' ? 'hi' : 'en';
    setLanguage(next);
    localStorage.setItem('fieldnote-language', next);
  };
  const navigate = (next: string) => {
    setView(next as View);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  if (booting)
    return (
      <div className="boot-screen">
        <Brand />
        <Loading />
      </div>
    );
  if (!user || authRequired)
    return (
      <Login
        onLogin={login}
        message={
          authRequired
            ? `Your session ended. Sign back in as ${user?.email}. Pending updates remain saved on this device.`
            : error
        }
        reauthEmail={authRequired ? user?.email : undefined}
      />
    );
  const manager = user.role === 'branch_manager';
  const lang = manager ? 'en' : language;
  const pending = outbox.filter((entry) => entry.status === 'pending').length;
  const currentLoan = loans.find((loan) => loan.id === selected);
  const navigation = manager
    ? [
        { key: 'overview', label: 'Overview', icon: LayoutDashboard },
        { key: 'work', label: 'Worklist', icon: ClipboardList },
        { key: 'promises', label: 'Promises', icon: CalendarCheck2 },
        { key: 'imports', label: 'Import & assign', icon: FileUp },
        { key: 'review', label: 'Reviews', icon: ShieldCheck },
        { key: 'activity', label: 'Activity & sync', icon: Activity },
      ]
    : [
        {
          key: 'work',
          label: words(lang, 'My cases', 'मेरे मामले'),
          icon: ClipboardList,
        },
        {
          key: 'promises',
          label: words(lang, 'Promises', 'वादे'),
          icon: CalendarCheck2,
        },
        {
          key: 'activity',
          label: words(lang, 'Activity', 'गतिविधि'),
          icon: Activity,
        },
      ];
  return (
    <div className={`app-shell ${manager ? 'manager' : 'officer'}`}>
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">
          {manager ? 'BRANCH WORKSPACE' : 'FIELD WORKSPACE'}
        </div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              className={view === item.key ? 'active' : ''}
              key={item.key}
              onClick={() => navigate(item.key)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {view === item.key && <span className="nav-indicator" />}
              {item.key === 'activity' && pending > 0 && (
                <span className="nav-count">{pending}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="sidebar-note-icon">
            <ShieldCheck size={21} />
          </span>
          <strong>Thoughtful follow-ups.</strong>
          <p>
            Contact hours
            <br />
            08:00–19:00 IST
          </p>
          <span className="demo-label">SYNTHETIC DEMO DATA</span>
        </div>
        <div className="sidebar-user">
          <span className="avatar">
            {user.full_name
              .split(' ')
              .map((part) => part[0])
              .slice(0, 2)
              .join('')}
          </span>
          <div>
            <strong>{user.full_name}</strong>
            <small>{manager ? 'Branch manager' : 'Field officer'}</small>
          </div>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={() => void logout()}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand">
            <Brand compact />
          </div>
          <div className="breadcrumb">
            <span>
              {manager
                ? 'Branch workspace'
                : words(lang, 'Field workspace', 'फ़ील्ड कार्यक्षेत्र')}
            </span>
            <ChevronRight size={14} />
            <strong>
              {navigation.find((item) => item.key === view)?.label}
            </strong>
          </div>
          <div className="topbar-actions">
            <button
              className={`connection-pill ${online ? '' : 'offline'}`}
              onClick={() => void flush()}
              title="Sync saved updates"
              disabled={syncing}
            >
              {syncing ? (
                <LoaderCircle className="spin" size={15} />
              ) : online ? (
                <Cloud size={16} />
              ) : (
                <CloudOff size={16} />
              )}
              <span>
                {syncing
                  ? words(lang, 'Syncing', 'सिंक हो रहा है')
                  : pending
                    ? `${pending} ${words(lang, 'pending', 'बाकी')}`
                    : online
                      ? words(lang, 'Up to date', 'अपडेट है')
                      : words(lang, 'Offline', 'ऑफलाइन')}
              </span>
            </button>
            {!manager && (
              <button className="language-button" onClick={toggleLanguage}>
                <Languages size={16} />
                {language === 'hi' ? 'English' : 'हिन्दी'}
              </button>
            )}
            <button
              className="icon-button refresh-button"
              aria-label="Refresh cases"
              disabled={!online || refreshing}
              onClick={() => {
                void refresh();
                void flush();
              }}
            >
              <RefreshCw className={refreshing ? 'spin' : ''} size={17} />
            </button>
            <button
              className="icon-button mobile-logout"
              aria-label="Sign out"
              onClick={() => void logout()}
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        {!online && (
          <div className="offline-banner" role="status">
            <WifiOff size={17} />
            <span>
              {words(
                lang,
                'You are offline. Keep recording outcomes; they will sync when you reconnect.',
                'आप ऑफलाइन हैं। नतीजे दर्ज करें; इंटरनेट आने पर सिंक होंगे।',
              )}
              {cacheTime && (
                <small>
                  {' '}
                  {words(lang, 'Cases saved', 'मामले सेव किए')}{' '}
                  {timeLabel(cacheTime)}
                </small>
              )}
            </span>
          </div>
        )}
        <main id="main-content">
          {error && (
            <div className="global-error">
              <Notice kind="error">{error}</Notice>
              <button className="text-link" onClick={() => setError('')}>
                Dismiss
              </button>
            </div>
          )}
          {view === 'overview' && manager && (
            <Overview
              loans={loans}
              revision={revision}
              online={online}
              onNavigate={navigate}
              onOpen={(loan) => setSelected(loan.id)}
            />
          )}
          {view === 'work' && (
            <Worklist
              loans={loans}
              language={lang}
              manager={manager}
              onOpen={(loan) => setSelected(loan.id)}
              onAssign={() => setDialog('assign')}
              onReorder={() => setDialog('reorder')}
            />
          )}
          {view === 'promises' && (
            <Promises
              loans={loans}
              language={lang}
              online={online}
              revision={revision}
              onOpen={(loan) => setSelected(loan.id)}
            />
          )}
          {view === 'activity' && (
            <DeviceActivity
              outbox={outbox}
              language={lang}
              online={online}
              syncing={syncing}
              onSync={() => void flush()}
            />
          )}
          {view === 'imports' && manager && (
            <Imports
              loans={loans}
              online={online}
              revision={revision}
              onRefresh={() => void refresh()}
              onOpenAssign={() => setDialog('assign')}
            />
          )}
          {view === 'review' && manager && (
            <Review
              loans={loans}
              online={online}
              revision={revision}
              onRefresh={() => void refresh()}
              onOpen={(loan) => setSelected(loan.id)}
            />
          )}
          <footer className="workspace-footer">
            <span>
              fieldnote<span className="brand-dot">.</span>
            </span>
            <span>
              {words(
                lang,
                'Every visit, accounted for.',
                'हर विज़िट का रिकॉर्ड।',
              )}
            </span>
          </footer>
        </main>
      </div>
      {!manager && (
        <nav className="bottom-nav" aria-label="Mobile navigation">
          {navigation.map((item) => (
            <button
              className={view === item.key ? 'active' : ''}
              key={item.key}
              onClick={() => navigate(item.key)}
            >
              <item.icon size={21} />
              <span>{item.label}</span>
              {item.key === 'activity' && pending > 0 && <i>{pending}</i>}
            </button>
          ))}
        </nav>
      )}
      {manager && (
        <nav className="manager-mobile-nav" aria-label="Mobile navigation">
          {navigation.map((item) => (
            <button
              className={view === item.key ? 'active' : ''}
              key={item.key}
              onClick={() => navigate(item.key)}
            >
              <item.icon size={17} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      )}
      {currentLoan && (
        <LoanDialog
          key={currentLoan.id}
          loan={currentLoan}
          user={user}
          language={lang}
          online={online}
          revision={revision}
          onClose={() => setSelected(null)}
          onSave={save}
          onRefresh={() => void refresh()}
        />
      )}
      {dialog === 'assign' && (
        <AssignmentDialog
          loans={loans}
          online={online}
          onClose={() => setDialog(null)}
          onRefresh={() => void refresh()}
        />
      )}
      {dialog === 'reorder' && (
        <ReorderDialog
          loans={loans}
          online={online}
          onClose={() => setDialog(null)}
          onRefresh={() => void refresh()}
        />
      )}
    </div>
  );
}

function Login({
  onLogin,
  message,
  reauthEmail,
}: {
  onLogin: (email: string, password: string) => Promise<void>;
  message: string;
  reauthEmail?: string;
}) {
  const [email, setEmail] = useState(reauthEmail || 'manager@fieldnote.demo');
  const [password, setPassword] = useState('Demo@12345');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onLogin(email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <section className="login-form-side">
        <Brand />
        <div className="login-form-content">
          <span className="eyebrow">GOOD FOLLOW-UPS START HERE</span>
          <h1>
            A better day
            <br />
            in the field.
          </h1>
          <p className="login-intro">
            Your cases, your next steps, and your team.
            <br />
            Together in one calm workspace.
          </p>
          <form onSubmit={submit} className="login-form">
            {message && <Notice>{message}</Notice>}
            {error && <Notice kind="error">{error}</Notice>}
            <label>
              Work email
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                readOnly={!!reauthEmail}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button
              className="button primary full login-submit"
              disabled={busy}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : null}
              {busy ? 'Opening your workspace…' : 'Sign in to Fieldnote'}
              {!busy && <ArrowRight size={18} />}
            </button>
          </form>
          {!reauthEmail && (
            <div className="demo-access">
              <div className="demo-heading">
                <span>EXPLORE THE DEMO</span>
                <BadgeText />
              </div>
              <div className="demo-buttons">
                <button
                  className={email.startsWith('manager') ? 'selected' : ''}
                  onClick={() => {
                    setEmail('manager@fieldnote.demo');
                    setPassword('Demo@12345');
                  }}
                >
                  <LayoutDashboard size={17} />
                  <span>Branch manager</span>
                  <ArrowUpRight size={15} />
                </button>
                <button
                  className={email.startsWith('officer') ? 'selected' : ''}
                  onClick={() => {
                    setEmail('officer@fieldnote.demo');
                    setPassword('Demo@12345');
                  }}
                >
                  <ClipboardList size={17} />
                  <span>Field officer</span>
                  <ArrowUpRight size={15} />
                </button>
              </div>
              <p>
                Demo password: <code>Demo@12345</code>. All borrower data is
                synthetic.
              </p>
            </div>
          )}
        </div>
        <div className="login-footer">
          <ShieldCheck size={15} />
          <span>Built for responsible field collections.</span>
        </div>
      </section>
      <section className="login-story">
        <div className="story-top">
          <span className="story-label">
            <span className="small-dot" />
            ON THE GROUND. IN SYNC.
          </span>
          <span className="story-number">01 / FIELDNOTES</span>
        </div>
        <div className="story-illustration" aria-hidden="true">
          <div className="route-line">
            <span />
            <span />
            <span />
          </div>
          <div className="illustration-paper paper-back" />
          <div className="illustration-paper">
            <div className="paper-header">
              <span className="paper-symbol">
                <ClipboardList size={27} />
              </span>
              <span>
                THE DAILY
                <br />
                <strong>FIELDNOTE</strong>
              </span>
            </div>
            <div className="paper-rule" />
            <div className="paper-check">
              <span>
                <Check size={16} />
              </span>
              <div>
                <strong>Know who needs you.</strong>
                <small>Clear priorities. Reasons included.</small>
              </div>
            </div>
            <div className="paper-check">
              <span>
                <Check size={16} />
              </span>
              <div>
                <strong>Make the visit count.</strong>
                <small>Record the outcome, even offline.</small>
              </div>
            </div>
            <div className="paper-check">
              <span>
                <Check size={16} />
              </span>
              <div>
                <strong>Keep your team in sync.</strong>
                <small>One shared picture of the day.</small>
              </div>
            </div>
            <div className="paper-bottom">
              <span>SMALL STEPS. CLEAR RECORDS.</span>
              <Sparkles size={21} />
            </div>
          </div>
          <div className="offline-sticker">
            <WifiOff size={19} />
            <span>
              Weak signal?
              <br />
              <strong>Your notes stay.</strong>
            </span>
          </div>
        </div>
        <div className="story-copy">
          <h2>
            Less paperwork.
            <br />
            More purposeful visits.
          </h2>
          <p>
            A field notebook that works where you do.
            <br />
            Online, offline, and on the move.
          </p>
        </div>
        <div className="story-footer">
          <span>English / हिन्दी</span>
          <span>Designed for the everyday.</span>
        </div>
      </section>
    </div>
  );
}
function BadgeText() {
  return <span className="tiny-badge">NO REAL PAYMENTS OR MESSAGES</span>;
}
