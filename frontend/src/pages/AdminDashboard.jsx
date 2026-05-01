import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import AkButton from '../components/AkButton';
import AdminMetricCard from '../components/AdminMetricCard';
import AdminTimeRangePicker from '../components/AdminTimeRangePicker';
import AdminEventTable from '../components/AdminEventTable';
import EmptyState from '../components/EmptyState';

const TABS = [
  { id: 'overview',  label: 'نظرة عامة' },
  { id: 'accounts',  label: 'الحسابات' },
  { id: 'games',     label: 'الألعاب' },
  { id: 'ai',        label: 'الذكاء الاصطناعي' },
  { id: 'events',    label: 'الأحداث' },
];

const ACCOUNTS_PAGE_SIZE = 25;
const EVENTS_PAGE_SIZE   = 25;

const FILTER_LABELS = {
  all:      'الكل',
  pending:  'انتظار',
  approved: 'موافق',
  rejected: 'مرفوض',
  deleted:  'محذوف',
  guests:   'الضيوف',
};

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [bootError, setBootError] = useState('');
  const [bootChecking, setBootChecking] = useState(true);

  // Overview state
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState('');

  // Date-range used by Games + AI tabs.
  const [range, setRange] = useState(() => {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    return {
      from: new Date(now.getTime() - 30 * day).toISOString(),
      to:   now.toISOString(),
    };
  });

  // Games tab
  const [games, setGames] = useState(null);
  const [gamesLoading, setGamesLoading] = useState(false);
  const [gamesError, setGamesError] = useState('');

  // AI tab
  const [aiMetrics, setAiMetrics] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  // Events tab
  const [eventType, setEventType] = useState('');
  const [eventOffset, setEventOffset] = useState(0);
  const [events, setEvents] = useState({ events: [], total: 0 });
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState('');

  // Accounts tab — sub-views: 'pending' | 'all' | 'maintenance'
  const [accountsView, setAccountsView] = useState('pending');
  const [accountsFilter, setAccountsFilter] = useState('all');
  const [accountsSearch, setAccountsSearch] = useState('');
  const [accountsOffset, setAccountsOffset] = useState(0);
  const [accounts, setAccounts] = useState({ accounts: [], total: 0 });
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState('');
  const [accountAction, setAccountAction] = useState(null); // { id, action, username }

  // Maintenance: cleanup expired guests
  const [cleanupPreview, setCleanupPreview] = useState(null); // { count, sample }
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupError, setCleanupError] = useState('');
  const [cleanupConfirming, setCleanupConfirming] = useState(false);
  const [cleanupResult, setCleanupResult] = useState('');

  // Maintenance: purge non-admin accounts
  const [purgePreview, setPurgePreview] = useState(null); // { count, sample }
  const [purgeLoading, setPurgeLoading] = useState(false);
  const [purgeError, setPurgeError] = useState('');
  const [purgeConfirmText, setPurgeConfirmText] = useState('');
  const [purgeConfirming, setPurgeConfirming] = useState(false);
  const [purgeResult, setPurgeResult] = useState('');

  // Bootstrapping: confirm the caller is admin before painting content.
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const data = await api.get('/api/auth/me');
        if (cancel) return;
        if (!data || !data.user || !data.user.isAdmin) {
          setBootError('مش مسموح لك تدخل لوحة التحكم.');
          return;
        }
        setBootError('');
      } catch (err) {
        if (cancel) return;
        setBootError(err.message || 'تعذّر التحقق من الصلاحيات.');
      } finally {
        if (!cancel) setBootChecking(false);
      }
    })();
    return () => { cancel = true; };
  }, []);

  // ---- Per-tab loaders -----------------------------------------------------

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setOverviewError('');
    try {
      const data = await api.get('/api/admin/metrics/overview');
      setOverview(data || null);
    } catch (err) {
      setOverviewError(err.message || 'تعذّر تحميل النظرة العامة.');
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadGames = useCallback(async () => {
    setGamesLoading(true);
    setGamesError('');
    try {
      const params = new URLSearchParams();
      if (range.from) params.set('from', range.from);
      if (range.to)   params.set('to',   range.to);
      const data = await api.get(`/api/admin/metrics/games?${params}`);
      setGames(data || null);
    } catch (err) {
      setGamesError(err.message || 'تعذّر تحميل بيانات الألعاب.');
    } finally {
      setGamesLoading(false);
    }
  }, [range]);

  const loadAi = useCallback(async () => {
    setAiLoading(true);
    setAiError('');
    try {
      const params = new URLSearchParams();
      if (range.from) params.set('from', range.from);
      if (range.to)   params.set('to',   range.to);
      const data = await api.get(`/api/admin/metrics/ai?${params}`);
      setAiMetrics(data || null);
    } catch (err) {
      setAiError(err.message || 'تعذّر تحميل بيانات الذكاء.');
    } finally {
      setAiLoading(false);
    }
  }, [range]);

  const loadEvents = useCallback(async (offset = 0) => {
    setEventsLoading(true);
    setEventsError('');
    try {
      const params = new URLSearchParams();
      if (eventType) params.set('type', eventType);
      params.set('limit',  String(EVENTS_PAGE_SIZE));
      params.set('offset', String(offset));
      const data = await api.get(`/api/admin/events?${params}`);
      setEvents({
        events: Array.isArray(data && data.events) ? data.events : [],
        total:  (data && Number.isFinite(data.total)) ? data.total : 0,
      });
      setEventOffset(offset);
    } catch (err) {
      setEventsError(err.message || 'تعذّر تحميل الأحداث.');
    } finally {
      setEventsLoading(false);
    }
  }, [eventType]);

  const loadAccounts = useCallback(async (view, offset, filter, search) => {
    if (view === 'maintenance') return;
    setAccountsLoading(true);
    setAccountsError('');
    try {
      let data;
      if (view === 'pending') {
        data = await api.get('/api/admin/accounts/pending');
        setAccounts({
          accounts: Array.isArray(data && data.accounts) ? data.accounts : [],
          total: 0,
        });
      } else {
        const params = new URLSearchParams();
        params.set('limit',  String(ACCOUNTS_PAGE_SIZE));
        params.set('offset', String(offset));
        if (filter && filter !== 'all') params.set('status', filter);
        if (search && search.trim()) params.set('search', search.trim());
        data = await api.get(`/api/admin/accounts?${params}`);
        setAccounts({
          accounts: Array.isArray(data && data.accounts) ? data.accounts : [],
          total: (data && Number.isFinite(data.total)) ? data.total : 0,
        });
        setAccountsOffset(offset);
      }
    } catch (err) {
      setAccountsError(err.message || 'تعذّر تحميل الحسابات.');
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  const handleAccountAction = useCallback(async (id, action) => {
    setAccountAction(null);
    setAccountsError('');
    try {
      if (action === 'approve') {
        await api.post(`/api/admin/accounts/${id}/approve`);
      } else if (action === 'reject') {
        await api.post(`/api/admin/accounts/${id}/reject`);
      } else if (action === 'delete') {
        await api.del(`/api/admin/accounts/${id}`);
      }
      loadAccounts(accountsView, accountsOffset, accountsFilter, accountsSearch);
    } catch (err) {
      setAccountsError(err.message || 'تعذّر تنفيذ الإجراء.');
    }
  }, [accountsView, accountsOffset, accountsFilter, accountsSearch, loadAccounts]);

  const handleCleanupDryRun = useCallback(async () => {
    setCleanupLoading(true);
    setCleanupError('');
    setCleanupPreview(null);
    setCleanupResult('');
    try {
      const data = await api.post('/api/admin/accounts/cleanup-guests', { dryRun: true });
      setCleanupPreview({ count: data.count || 0, sample: data.sample || [] });
    } catch (err) {
      setCleanupError(err.message || 'تعذّر تشغيل الفحص المسبق.');
    } finally {
      setCleanupLoading(false);
    }
  }, []);

  const handleCleanupConfirm = useCallback(async () => {
    setCleanupConfirming(true);
    setCleanupError('');
    setCleanupResult('');
    try {
      const data = await api.post('/api/admin/accounts/cleanup-guests', {
        dryRun: false,
        confirm: 'DELETE_EXPIRED_GUESTS',
      });
      setCleanupPreview(null);
      setCleanupResult(`تم حذف ${data.deleted ?? 0} حساب ضيف منتهي الصلاحية.`);
    } catch (err) {
      setCleanupError(err.message || 'تعذّر تنفيذ التنظيف.');
    } finally {
      setCleanupConfirming(false);
    }
  }, []);

  const handlePurgeDryRun = useCallback(async () => {
    setPurgeLoading(true);
    setPurgeError('');
    setPurgePreview(null);
    setPurgeConfirmText('');
    setPurgeResult('');
    try {
      const data = await api.post('/api/admin/accounts/purge-non-admin', { dryRun: true });
      setPurgePreview({ count: data.count || 0, sample: data.sample || [] });
    } catch (err) {
      setPurgeError(err.message || 'تعذّر تشغيل الفحص المسبق.');
    } finally {
      setPurgeLoading(false);
    }
  }, []);

  const handlePurgeConfirm = useCallback(async () => {
    if (purgeConfirmText !== 'DELETE_NON_ADMIN_ACCOUNTS') {
      setPurgeError('يجب كتابة نص التأكيد بالضبط: DELETE_NON_ADMIN_ACCOUNTS');
      return;
    }
    setPurgeConfirming(true);
    setPurgeError('');
    setPurgeResult('');
    try {
      const data = await api.post('/api/admin/accounts/purge-non-admin', {
        dryRun: false,
        confirm: 'DELETE_NON_ADMIN_ACCOUNTS',
      });
      setPurgePreview(null);
      setPurgeConfirmText('');
      setPurgeResult(`تم حذف ${data.count ?? 0} حساب.`);
    } catch (err) {
      setPurgeError(err.message || 'تعذّر تنفيذ الحذف الجماعي.');
    } finally {
      setPurgeConfirming(false);
    }
  }, [purgeConfirmText]);

  // Mount loads.
  useEffect(() => { if (!bootChecking && !bootError) loadOverview(); }, [bootChecking, bootError, loadOverview]);

  // Tab-specific loads.
  useEffect(() => {
    if (bootChecking || bootError) return;
    if (tab === 'accounts' && accountsView !== 'maintenance') {
      loadAccounts(accountsView, 0, accountsFilter, accountsSearch);
    }
    if (tab === 'games')  loadGames();
    if (tab === 'ai')     loadAi();
    if (tab === 'events') loadEvents(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, range, accountsView, bootChecking, bootError]);

  // Cards for the overview tab — derived from server response.
  const overviewCards = useMemo(() => {
    if (!overview) return [];
    return [
      { label: 'إجمالي الألعاب',          value: overview.totalSessions,        tone: 'gold' },
      { label: 'ألعاب آخر 24 ساعة',      value: overview.sessionsToday,        tone: 'neutral' },
      { label: 'ألعاب آخر 7 أيام',       value: overview.sessionsLast7d,       tone: 'neutral' },
      { label: 'إجمالي المستخدمين',       value: overview.totalUsers,           tone: 'neutral' },
      { label: 'مستخدمون مسجَّلون',       value: overview.registeredUsers,      tone: 'neutral' },
      { label: 'حسابات ضيف',             value: overview.guestUsers,           tone: 'neutral' },
      { label: 'مشرفون',                 value: overview.adminUsers,           tone: 'gold' },
      { label: 'حسابات بانتظار الموافقة', value: overview.pendingAccounts,      tone: 'crimson' },
      { label: 'استدعاءات الذكاء (7ي)',   value: overview.aiCallsLast7d,        tone: 'neutral' },
      { label: 'إخفاقات الذكاء (7ي)',    value: overview.aiFailuresLast7d,     tone: 'crimson' },
    ];
  }, [overview]);

  if (bootChecking) {
    return (
      <div className="s-admin">
        <div className="s-admin-hero">
          <h1>لوحة المشرف</h1>
          <p className="ov">جاري التحقق من الصلاحيات…</p>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="s-admin">
        <div className="s-admin-hero">
          <h1>لوحة المشرف</h1>
          <p className="ov">{bootError}</p>
        </div>
        <div style={{ marginTop: 'var(--ak-space-4)', textAlign: 'center' }}>
          <AkButton variant="ghost" onClick={() => navigate('/lobby')}>الرجوع للساحة</AkButton>
        </div>
      </div>
    );
  }

  return (
    <div className="s-admin">
      <div className="s-admin-hero">
        <span className="ov">Admin · Protocol Zero</span>
        <h1>لوحة <span className="glow">المشرف</span></h1>
        <p>الأرقام دي بتتبني من الأرشيف بشكل مباشر. الأحداث محمية بـ allow-list من جهة الخادم.</p>
      </div>

      <nav className="s-admin-tabs" role="tablist" aria-label="أقسام لوحة المشرف">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 's-admin-tab s-admin-tab-active' : 's-admin-tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* ------------------------------------------------------------------ */}
      {/* Overview                                                            */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'overview' && (
        <section className="s-admin-section">
          {overviewError && (
            <div className="s-auth-error" style={{ marginBottom: 'var(--ak-space-3)' }}>{overviewError}</div>
          )}
          <div className="s-admin-grid">
            {(overviewLoading && !overview)
              ? Array.from({ length: 9 }).map((_, i) => (
                  <AdminMetricCard key={i} label="…" value={null} loading />
                ))
              : overviewCards.map((c, i) => (
                  <AdminMetricCard
                    key={i}
                    label={c.label}
                    value={c.value}
                    tone={c.tone}
                  />
                ))
            }
          </div>
          <div style={{ marginTop: 'var(--ak-space-3)', textAlign: 'end' }}>
            <AkButton variant="ghost" onClick={loadOverview} disabled={overviewLoading}>
              تحديث
            </AkButton>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Accounts — unified: pending queue + all accounts + maintenance      */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'accounts' && (
        <section className="s-admin-section">

          {/* Sub-view navigation */}
          <div style={{ display: 'flex', gap: 'var(--ak-space-2)', flexWrap: 'wrap', marginBottom: 'var(--ak-space-3)', alignItems: 'center' }}>
            {[
              { id: 'pending',     label: 'طابور الانتظار' },
              { id: 'all',         label: 'جميع الحسابات' },
              { id: 'maintenance', label: 'الصيانة الخطرة' },
            ].map(v => (
              <button
                key={v.id}
                type="button"
                className={accountsView === v.id ? 's-admin-tab s-admin-tab-active' : 's-admin-tab'}
                onClick={() => setAccountsView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>

          {accountsError && (
            <div className="s-auth-error" style={{ marginBottom: 'var(--ak-space-3)' }}>{accountsError}</div>
          )}

          {/* Search + filter bar — only in 'all' view */}
          {accountsView === 'all' && (
            <>
              <div style={{ display: 'flex', gap: 'var(--ak-space-2)', flexWrap: 'wrap', marginBottom: 'var(--ak-space-2)', alignItems: 'flex-end' }}>
                <label className="s-admin-rangepicker-field" style={{ flex: 1, minWidth: '180px' }}>
                  <span>البحث باسم المستخدم</span>
                  <input
                    type="text"
                    value={accountsSearch}
                    onChange={e => setAccountsSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') loadAccounts('all', 0, accountsFilter, accountsSearch); }}
                    placeholder="اسم مستخدم…"
                  />
                </label>
                <AkButton
                  variant="ghost"
                  onClick={() => loadAccounts('all', 0, accountsFilter, accountsSearch)}
                  disabled={accountsLoading}
                  style={{ padding: '0.4rem 0.9rem', minHeight: 'auto', fontSize: '0.85rem', alignSelf: 'flex-end' }}
                >
                  بحث
                </AkButton>
              </div>

              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: 'var(--ak-space-3)' }}>
                {Object.entries(FILTER_LABELS).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className="s-admin-pill"
                    style={{ opacity: accountsFilter === key ? 1 : 0.45, cursor: 'pointer' }}
                    onClick={() => {
                      setAccountsFilter(key);
                      loadAccounts('all', 0, key, accountsSearch);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Row-level confirm dialog */}
          {accountAction && (
            <div className="s-report-section" style={{
              marginBottom: 'var(--ak-space-3)',
              background: 'var(--ak-crimson-bg-muted)',
              border: '1px solid var(--ak-border-red)',
              borderRadius: 'var(--ak-radius-md)',
              padding: 'var(--ak-space-3)',
            }}>
              <p style={{ marginBottom: 'var(--ak-space-2)' }}>
                تأكيد إجراء{' '}
                <strong style={{ color: 'var(--ak-crimson-action)' }}>
                  {accountAction.action === 'approve' ? 'موافقة' :
                   accountAction.action === 'reject'  ? 'رفض'    : 'حذف'}
                </strong>{' '}
                على <strong>{accountAction.username || `#${accountAction.id}`}</strong>؟
              </p>
              <div style={{ display: 'flex', gap: 'var(--ak-space-2)' }}>
                <AkButton variant="primary" onClick={() => handleAccountAction(accountAction.id, accountAction.action)}>
                  تأكيد
                </AkButton>
                <AkButton variant="ghost" onClick={() => setAccountAction(null)}>
                  إلغاء
                </AkButton>
              </div>
            </div>
          )}

          {/* Accounts table — pending + all views */}
          {accountsView !== 'maintenance' && (
            <>
              <div className="s-admin-event-table-scroll">
                <table className="s-admin-event-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>الاسم</th>
                      <th>الحالة</th>
                      <th>الألعاب</th>
                      <th>تاريخ الإنشاء</th>
                      <th>تاريخ الانتهاء</th>
                      <th>إجراءات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountsLoading && accounts.accounts.length === 0 ? (
                      <tr><td colSpan="7"><div className="shimmer" style={{ height: '6rem' }} aria-hidden="true" /></td></tr>
                    ) : accounts.accounts.length === 0 ? (
                      <tr>
                        <td colSpan="7" style={{ textAlign: 'center', color: 'var(--ak-text-muted)', padding: 'var(--ak-space-4)' }}>
                          {accountsView === 'pending' ? 'ما فيش حسابات بانتظار الموافقة.' : 'ما فيش حسابات مطابقة.'}
                        </td>
                      </tr>
                    ) : accounts.accounts.map(a => (
                      <tr key={a.id}>
                        <td>{a.id}</td>
                        <td>
                          <span>{a.username || '—'}</span>
                          {a.isAdmin && (
                            <span className="s-admin-pill" style={{ marginInlineStart: '0.4rem', color: 'var(--ak-gold)' }}>مشرف</span>
                          )}
                          {a.isGuest && (
                            <span className="s-admin-pill" style={{ marginInlineStart: '0.4rem', opacity: 0.6 }}>ضيف</span>
                          )}
                        </td>
                        <td>
                          <span style={{
                            color: a.status === 'pending'  ? 'var(--ak-gold)'          :
                                   a.status === 'approved' ? 'var(--ak-text-strong)'    :
                                   a.status === 'rejected' ? 'var(--ak-crimson-action)' :
                                                             'var(--ak-text-muted)',
                          }}>
                            {a.status === 'pending'  ? 'انتظار' :
                             a.status === 'approved' ? 'موافق'  :
                             a.status === 'rejected' ? 'مرفوض'  : 'محذوف'}
                          </span>
                          {a.approvedAt && a.status === 'approved' && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--ak-text-muted)' }}>{a.approvedAt.slice(0, 10)}</div>
                          )}
                          {a.rejectedAt && a.status === 'rejected' && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--ak-text-muted)' }}>{a.rejectedAt.slice(0, 10)}</div>
                          )}
                          {a.deletedAt && a.status === 'deleted' && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--ak-text-muted)' }}>{a.deletedAt.slice(0, 10)}</div>
                          )}
                        </td>
                        <td>{a.gamesPlayed}</td>
                        <td>{a.createdAt ? a.createdAt.slice(0, 10) : '—'}</td>
                        <td>
                          {a.isGuest && a.expiresAt ? (
                            <span style={{ color: new Date(a.expiresAt) < new Date() ? 'var(--ak-crimson-action)' : 'inherit' }}>
                              {a.expiresAt.slice(0, 10)}
                            </span>
                          ) : '—'}
                        </td>
                        <td>
                          {a.isAdmin ? (
                            <span style={{ color: 'var(--ak-text-muted)', fontSize: '0.8rem' }}>محمي</span>
                          ) : (
                            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                              {(a.status === 'pending' || a.status === 'rejected') && (
                                <button
                                  type="button"
                                  className="s-admin-pill"
                                  style={{ color: 'var(--ak-text-strong)', cursor: 'pointer' }}
                                  onClick={() => setAccountAction({ id: a.id, action: 'approve', username: a.username })}
                                >
                                  موافقة
                                </button>
                              )}
                              {a.status !== 'rejected' && a.status !== 'deleted' && !a.isGuest && (
                                <button
                                  type="button"
                                  className="s-admin-pill"
                                  style={{ color: 'var(--ak-crimson-action)', cursor: 'pointer' }}
                                  onClick={() => setAccountAction({ id: a.id, action: 'reject', username: a.username })}
                                >
                                  رفض
                                </button>
                              )}
                              {a.status !== 'deleted' && (
                                <button
                                  type="button"
                                  className="s-admin-pill"
                                  style={{ color: 'var(--ak-text-muted)', cursor: 'pointer' }}
                                  onClick={() => setAccountAction({ id: a.id, action: 'delete', username: a.username })}
                                >
                                  حذف
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {accountsView === 'all' && accounts.total > ACCOUNTS_PAGE_SIZE && (
                <div className="s-admin-pagination">
                  <button
                    type="button"
                    className="s-admin-pill"
                    disabled={accountsOffset === 0 || accountsLoading}
                    onClick={() => loadAccounts('all', Math.max(0, accountsOffset - ACCOUNTS_PAGE_SIZE), accountsFilter, accountsSearch)}
                  >
                    السابق
                  </button>
                  <span>
                    {accountsOffset + 1}–{Math.min(accountsOffset + ACCOUNTS_PAGE_SIZE, accounts.total)} من {accounts.total}
                  </span>
                  <button
                    type="button"
                    className="s-admin-pill"
                    disabled={accountsOffset + ACCOUNTS_PAGE_SIZE >= accounts.total || accountsLoading}
                    onClick={() => loadAccounts('all', accountsOffset + ACCOUNTS_PAGE_SIZE, accountsFilter, accountsSearch)}
                  >
                    التالي
                  </button>
                </div>
              )}

              <div style={{ marginTop: 'var(--ak-space-3)', textAlign: 'end' }}>
                <AkButton
                  variant="ghost"
                  onClick={() => loadAccounts(accountsView, accountsView === 'all' ? accountsOffset : 0, accountsFilter, accountsSearch)}
                  disabled={accountsLoading}
                >
                  تحديث
                </AkButton>
              </div>
            </>
          )}

          {/* Maintenance panel */}
          {accountsView === 'maintenance' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ak-space-4)' }}>

              {/* Cleanup expired guests */}
              <div style={{ border: '1px solid var(--ak-border)', borderRadius: 'var(--ak-radius-md)', padding: 'var(--ak-space-3)' }}>
                <h3 className="section-title" style={{ marginTop: 0 }}>تنظيف الضيوف المنتهيين</h3>
                <p style={{ color: 'var(--ak-text-muted)', marginBottom: 'var(--ak-space-3)', fontSize: '0.9rem' }}>
                  حذف ناعم لحسابات الضيوف التي انتهت صلاحيتها. لا يحذف سجلات الجلسات أو بيانات المشاركة.
                </p>

                {cleanupError && (
                  <div className="s-auth-error" style={{ marginBottom: 'var(--ak-space-2)' }}>{cleanupError}</div>
                )}
                {cleanupResult && (
                  <div className="s-host-toast ok" role="status" style={{ display: 'block', marginBottom: 'var(--ak-space-2)' }}>
                    {cleanupResult}
                  </div>
                )}

                {!cleanupPreview ? (
                  <AkButton variant="ghost" onClick={handleCleanupDryRun} disabled={cleanupLoading}>
                    {cleanupLoading ? 'جاري الفحص...' : 'فحص مسبق dry-run'}
                  </AkButton>
                ) : (
                  <div>
                    <div style={{
                      background: 'var(--ak-crimson-bg-muted)',
                      border: '1px solid var(--ak-border-red)',
                      borderRadius: 'var(--ak-radius-md)',
                      padding: 'var(--ak-space-2)',
                      marginBottom: 'var(--ak-space-2)',
                    }}>
                      <p style={{ marginBottom: 'var(--ak-space-1)', fontWeight: 600 }}>
                        عدد الحسابات المؤهلة للحذف:{' '}
                        <span style={{ color: 'var(--ak-crimson-action)' }}>{cleanupPreview.count}</span>
                      </p>
                      {cleanupPreview.sample.length > 0 && (
                        <ul style={{ margin: 0, paddingInlineStart: '1rem', color: 'var(--ak-text-muted)', fontSize: '0.85rem' }}>
                          {cleanupPreview.sample.slice(0, 5).map(s => (
                            <li key={s.id}>
                              {s.username || `#${s.id}`} — انتهى: {s.expiresAt ? s.expiresAt.slice(0, 10) : '—'}
                            </li>
                          ))}
                          {cleanupPreview.sample.length > 5 && <li>وغيرهم…</li>}
                        </ul>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 'var(--ak-space-2)', flexWrap: 'wrap' }}>
                      {cleanupPreview.count > 0 && (
                        <AkButton variant="primary" onClick={handleCleanupConfirm} disabled={cleanupConfirming}>
                          {cleanupConfirming ? 'جاري الحذف...' : `تأكيد حذف ${cleanupPreview.count} حساب`}
                        </AkButton>
                      )}
                      <AkButton variant="ghost" onClick={() => { setCleanupPreview(null); setCleanupError(''); setCleanupResult(''); }}>
                        إلغاء
                      </AkButton>
                    </div>
                  </div>
                )}
              </div>

              {/* Purge non-admin accounts */}
              <div style={{
                border: '1px solid var(--ak-border-red)',
                borderRadius: 'var(--ak-radius-md)',
                padding: 'var(--ak-space-3)',
                background: 'var(--ak-crimson-bg-muted)',
              }}>
                <h3 className="section-title" style={{ marginTop: 0, color: 'var(--ak-crimson-action)' }}>
                  حذف جميع الحسابات غير المشرفين
                </h3>
                <p style={{ color: 'var(--ak-text-muted)', marginBottom: 'var(--ak-space-3)', fontSize: '0.9rem' }}>
                  عملية خطرة: تحذف ناعماً جميع الحسابات المسجَّلة وحسابات الضيوف غير المحذوفة بالفعل.
                  المشرفون محميون. البيانات المرتبطة (الجلسات) تُحفظ.
                </p>

                {purgeError && (
                  <div className="s-auth-error" style={{ marginBottom: 'var(--ak-space-2)' }}>{purgeError}</div>
                )}
                {purgeResult && (
                  <div className="s-host-toast ok" role="status" style={{ display: 'block', marginBottom: 'var(--ak-space-2)' }}>
                    {purgeResult}
                  </div>
                )}

                {!purgePreview ? (
                  <AkButton variant="ghost" onClick={handlePurgeDryRun} disabled={purgeLoading}>
                    {purgeLoading ? 'جاري الفحص...' : 'فحص مسبق dry-run'}
                  </AkButton>
                ) : (
                  <div>
                    <div style={{
                      background: 'rgba(0,0,0,0.25)',
                      border: '1px solid var(--ak-border-red)',
                      borderRadius: 'var(--ak-radius-md)',
                      padding: 'var(--ak-space-2)',
                      marginBottom: 'var(--ak-space-2)',
                    }}>
                      <p style={{ marginBottom: 'var(--ak-space-1)', fontWeight: 600 }}>
                        عدد الحسابات المؤهلة للحذف:{' '}
                        <span style={{ color: 'var(--ak-crimson-action)' }}>{purgePreview.count}</span>
                      </p>
                      {purgePreview.sample.length > 0 && (
                        <ul style={{ margin: 0, paddingInlineStart: '1rem', color: 'var(--ak-text-muted)', fontSize: '0.85rem' }}>
                          {purgePreview.sample.slice(0, 5).map(s => (
                            <li key={s.id}>{s.username || `#${s.id}`} ({s.status})</li>
                          ))}
                          {purgePreview.sample.length > 5 && <li>وغيرهم…</li>}
                        </ul>
                      )}
                    </div>

                    {purgePreview.count > 0 && (
                      <div style={{ marginBottom: 'var(--ak-space-2)' }}>
                        <label className="s-admin-rangepicker-field">
                          <span style={{ color: 'var(--ak-crimson-action)' }}>
                            اكتب <code>DELETE_NON_ADMIN_ACCOUNTS</code> للتأكيد:
                          </span>
                          <input
                            type="text"
                            value={purgeConfirmText}
                            onChange={e => setPurgeConfirmText(e.target.value)}
                            placeholder="DELETE_NON_ADMIN_ACCOUNTS"
                            style={{ fontFamily: 'monospace' }}
                          />
                        </label>
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 'var(--ak-space-2)', flexWrap: 'wrap' }}>
                      {purgePreview.count > 0 && (
                        <AkButton
                          variant="primary"
                          onClick={handlePurgeConfirm}
                          disabled={purgeConfirming || purgeConfirmText !== 'DELETE_NON_ADMIN_ACCOUNTS'}
                          style={{ opacity: purgeConfirmText !== 'DELETE_NON_ADMIN_ACCOUNTS' ? 0.45 : 1 }}
                        >
                          {purgeConfirming ? 'جاري الحذف...' : `تأكيد حذف ${purgePreview.count} حساب`}
                        </AkButton>
                      )}
                      <AkButton variant="ghost" onClick={() => { setPurgePreview(null); setPurgeConfirmText(''); setPurgeError(''); setPurgeResult(''); }}>
                        إلغاء
                      </AkButton>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Games                                                               */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'games' && (
        <section className="s-admin-section">
          <AdminTimeRangePicker value={range} onChange={setRange} />
          {gamesError && (
            <div className="s-auth-error" style={{ marginBottom: 'var(--ak-space-3)' }}>{gamesError}</div>
          )}
          <div className="s-admin-grid">
            <AdminMetricCard label="متوسط جولات" value={games && games.avgRounds} tone="gold" loading={gamesLoading} />
            <AdminMetricCard label="متوسط مدة (ث)" value={games && games.avgDurationSec} tone="neutral" loading={gamesLoading} />
            <AdminMetricCard
              label="ألعاب مخصصة / إجمالي"
              value={games && games.customUsage
                ? `${games.customUsage.custom}/${games.customUsage.total}`
                : null
              }
              loading={gamesLoading}
            />
          </div>

          <BarBreakdown title="حسب نوع الاستضافة" data={games && games.byMode} loading={gamesLoading} />
          <BarBreakdown title="حسب وضع الكشف" data={games && games.byRevealMode} loading={gamesLoading} />
          <BarBreakdown title="النتيجة" data={games && games.byOutcome} loading={gamesLoading} />
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* AI                                                                  */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'ai' && (
        <section className="s-admin-section">
          <AdminTimeRangePicker value={range} onChange={setRange} />
          {aiError && (
            <div className="s-auth-error" style={{ marginBottom: 'var(--ak-space-3)' }}>{aiError}</div>
          )}
          <div className="s-admin-grid">
            <AdminMetricCard
              label="متوسط زمن الاستجابة (ms)"
              value={aiMetrics && aiMetrics.overallAvgLatencyMs}
              tone="neutral"
              loading={aiLoading}
            />
            <AdminMetricCard
              label="أقصى زمن (ms)"
              value={aiMetrics && aiMetrics.overallMaxLatencyMs}
              tone="crimson"
              loading={aiLoading}
            />
          </div>

          <h3 className="section-title">حسب المهمة والمصدر</h3>
          {aiLoading && !aiMetrics ? (
            <div className="shimmer" style={{ height: '8rem' }} aria-hidden="true" />
          ) : (
            <div className="s-admin-event-table-scroll">
              <table className="s-admin-event-table">
                <thead>
                  <tr>
                    <th>المهمة</th>
                    <th>المصدر</th>
                    <th>المحاولات</th>
                    <th>النجاح</th>
                    <th>متوسط (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {(aiMetrics && Array.isArray(aiMetrics.byTaskSource) && aiMetrics.byTaskSource.length > 0) ? (
                    aiMetrics.byTaskSource.map((row, i) => (
                      <tr key={`${row.task}-${row.source}-${i}`}>
                        <td>{row.task || '—'}</td>
                        <td>{row.source || '—'}</td>
                        <td>{row.attempts}</td>
                        <td>{row.successes}</td>
                        <td>{row.avgLatencyMs !== null ? Math.round(row.avgLatencyMs) : '—'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="5" style={{ textAlign: 'center', color: 'var(--ak-text-muted)', padding: 'var(--ak-space-4)' }}>
                        ما فيش محاولات ذكاء في النطاق ده.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {(aiMetrics && Array.isArray(aiMetrics.topFailureReasons) && aiMetrics.topFailureReasons.length > 0) && (
            <>
              <h3 className="section-title">أبرز أسباب الفشل</h3>
              <ul className="s-admin-fail-list">
                {aiMetrics.topFailureReasons.map((r, i) => (
                  <li key={i}>
                    <span className="s-admin-fail-reason">{r.reason}</span>
                    <span className="s-admin-fail-count">{r.count}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Events                                                              */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'events' && (
        <section className="s-admin-section">
          <div className="s-admin-rangepicker-inputs" style={{ marginBottom: 'var(--ak-space-3)' }}>
            <label className="s-admin-rangepicker-field">
              <span>نوع الحدث</span>
              <input
                type="text"
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                placeholder="مثال: session.ended"
              />
            </label>
            <AkButton variant="ghost" onClick={() => loadEvents(0)} disabled={eventsLoading}>
              تطبيق
            </AkButton>
          </div>
          <AdminEventTable
            events={events.events}
            loading={eventsLoading}
            error={eventsError}
            total={events.total}
            limit={EVENTS_PAGE_SIZE}
            offset={eventOffset}
            onChangePage={(off) => loadEvents(off)}
          />
        </section>
      )}

      <div style={{ marginTop: 'var(--ak-space-4)', textAlign: 'center' }}>
        <AkButton variant="ghost" onClick={() => navigate('/lobby')}>الرجوع للساحة</AkButton>
      </div>
    </div>
  );
}

/**
 * BarBreakdown — pure-CSS horizontal bar chart for { key: count } maps.
 * Used by the Games tab for byMode / byRevealMode / byOutcome.
 */
function BarBreakdown({ title, data, loading }) {
  if (loading && !data) {
    return (
      <>
        <h3 className="section-title">{title}</h3>
        <div className="shimmer" style={{ height: '5rem' }} aria-hidden="true" />
      </>
    );
  }
  const entries = data && typeof data === 'object' ? Object.entries(data) : [];
  if (entries.length === 0) {
    return (
      <>
        <h3 className="section-title">{title}</h3>
        <EmptyState tone="compact" title="ما فيش بيانات في النطاق ده" />
      </>
    );
  }
  const max = Math.max(...entries.map(([, n]) => Number(n) || 0), 1);
  return (
    <>
      <h3 className="section-title">{title}</h3>
      <ul className="s-admin-bar-list">
        {entries.map(([k, n]) => (
          <li key={k} className="s-admin-bar-row">
            <span className="s-admin-bar-label">{k}</span>
            <span className="s-admin-bar-track">
              <span
                className="s-admin-bar-fill"
                style={{ width: `${Math.max(2, (Number(n) || 0) / max * 100)}%` }}
              />
            </span>
            <span className="s-admin-bar-count">{n}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
