import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import AkButton from '../components/AkButton';
import AdminMetricCard from '../components/AdminMetricCard';
import AdminTimeRangePicker from '../components/AdminTimeRangePicker';
import AdminEventTable from '../components/AdminEventTable';

/**
 * AdminDashboard — F4. Three primary tabs (Overview / Games / AI) plus a
 * raw events browser and a users table. All data comes from /api/admin/*
 * which is gated by the F2 admin middleware.
 *
 * Privacy:
 *   - This page never renders archive_b64, final_reveal, voting_history,
 *     roleAssignments, JWTs, or password hashes. The API never returns
 *     them; this UI is the second-line defense (it would have nothing
 *     to render even if the API regressed).
 *   - The route guard checks /api/auth/me.user.isAdmin (DB-backed in F2)
 *     and bounces non-admins to /lobby.
 *
 * Loading / error / empty states:
 *   - Each tab has its own loadKey + error slot so a transient failure
 *     in one tab doesn't blank the whole dashboard.
 */
const TABS = [
  { id: 'overview',  label: 'نظرة عامة' },
  { id: 'accounts',  label: 'الحسابات' },
  { id: 'games',     label: 'الألعاب' },
  { id: 'ai',        label: 'الذكاء الاصطناعي' },
  { id: 'events',    label: 'الأحداث' },
  { id: 'users',     label: 'المستخدمون' },
];

const EVENTS_PAGE_SIZE = 25;
const USERS_PAGE_SIZE = 25;

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

  // Users tab
  const [userSearch, setUserSearch] = useState('');
  const [userOffset, setUserOffset] = useState(0);
  const [users, setUsers] = useState({ users: [], total: 0 });
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState('');

  // Accounts tab
  const [accountsView, setAccountsView] = useState('pending'); // 'pending' | 'all'
  const [accountsStatus, setAccountsStatus] = useState('all');
  const [accountsOffset, setAccountsOffset] = useState(0);
  const [accounts, setAccounts] = useState({ accounts: [], total: 0 });
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState('');
  const [accountAction, setAccountAction] = useState(null); // { id, action: 'approve'|'reject'|'delete' }

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
      params.set('limit', String(EVENTS_PAGE_SIZE));
      params.set('offset', String(offset));
      const data = await api.get(`/api/admin/events?${params}`);
      setEvents({
        events: Array.isArray(data && data.events) ? data.events : [],
        total: (data && Number.isFinite(data.total)) ? data.total : 0,
      });
      setEventOffset(offset);
    } catch (err) {
      setEventsError(err.message || 'تعذّر تحميل الأحداث.');
    } finally {
      setEventsLoading(false);
    }
  }, [eventType]);

  const loadUsers = useCallback(async (offset = 0) => {
    setUsersLoading(true);
    setUsersError('');
    try {
      const params = new URLSearchParams();
      params.set('limit', String(USERS_PAGE_SIZE));
      params.set('offset', String(offset));
      if (userSearch) params.set('search', userSearch);
      const data = await api.get(`/api/admin/users?${params}`);
      setUsers({
        users: Array.isArray(data && data.users) ? data.users : [],
        total: (data && Number.isFinite(data.total)) ? data.total : 0,
      });
      setUserOffset(offset);
    } catch (err) {
      setUsersError(err.message || 'تعذّر تحميل المستخدمين.');
    } finally {
      setUsersLoading(false);
    }
  }, [userSearch]);

  const loadAccounts = useCallback(async (view = accountsView, offset = 0) => {
    setAccountsLoading(true);
    setAccountsError('');
    try {
      let data;
      if (view === 'pending') {
        data = await api.get('/api/admin/accounts/pending');
        setAccounts({ accounts: Array.isArray(data && data.accounts) ? data.accounts : [], total: 0 });
      } else {
        const params = new URLSearchParams();
        params.set('limit', String(USERS_PAGE_SIZE));
        params.set('offset', String(offset));
        if (accountsStatus !== 'all') params.set('status', accountsStatus);
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
  }, [accountsView, accountsStatus]);

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
      loadAccounts(accountsView, accountsOffset);
    } catch (err) {
      setAccountsError(err.message || 'تعذّر تنفيذ الإجراء.');
    }
  }, [accountsView, accountsOffset, loadAccounts]);

  const handleCleanupGuests = useCallback(async () => {
    setAccountsError('');
    try {
      const data = await api.post('/api/admin/accounts/cleanup-guests');
      alert(`تم حذف ${data.deleted || 0} حساب ضيف منتهي.`);
      loadAccounts(accountsView, accountsOffset);
    } catch (err) {
      setAccountsError(err.message || 'تعذّر تنظيف الضيوف.');
    }
  }, [accountsView, accountsOffset, loadAccounts]);

  // Mount loads.
  useEffect(() => { if (!bootChecking && !bootError) loadOverview(); }, [bootChecking, bootError, loadOverview]);

  // Tab-specific loads.
  useEffect(() => {
    if (bootChecking || bootError) return;
    if (tab === 'accounts') loadAccounts(accountsView, 0);
    if (tab === 'games') loadGames();
    if (tab === 'ai')    loadAi();
    if (tab === 'events') loadEvents(0);
    if (tab === 'users') loadUsers(0);
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

      {tab === 'accounts' && (
        <section className="s-admin-section">
          <div style={{ display: 'flex', gap: 'var(--ak-space-2)', flexWrap: 'wrap', marginBottom: 'var(--ak-space-3)', alignItems: 'center' }}>
            <button
              type="button"
              className={accountsView === 'pending' ? 's-admin-tab s-admin-tab-active' : 's-admin-tab'}
              onClick={() => { setAccountsView('pending'); loadAccounts('pending', 0); }}
            >
              طابور الانتظار
            </button>
            <button
              type="button"
              className={accountsView === 'all' ? 's-admin-tab s-admin-tab-active' : 's-admin-tab'}
              onClick={() => { setAccountsView('all'); loadAccounts('all', 0); }}
            >
              جميع الحسابات
            </button>
            <span style={{ flexGrow: 1 }} />
            <AkButton
              variant="ghost"
              onClick={handleCleanupGuests}
              style={{ padding: '0.4rem 0.8rem', minHeight: 'auto', fontSize: '0.85rem' }}
            >
              تنظيف الضيوف المنتهيين
            </AkButton>
          </div>

          {accountsError && (
            <div className="s-auth-error" style={{ marginBottom: 'var(--ak-space-3)' }}>{accountsError}</div>
          )}

          {accountsView === 'all' && (
            <div style={{ display: 'flex', gap: 'var(--ak-space-2)', marginBottom: 'var(--ak-space-3)', flexWrap: 'wrap' }}>
              {['all','pending','approved','rejected','deleted'].map(s => (
                <button
                  key={s}
                  type="button"
                  className={accountsStatus === s ? 's-admin-pill' : 's-admin-pill'}
                  style={{ opacity: accountsStatus === s ? 1 : 0.5 }}
                  onClick={() => { setAccountsStatus(s); loadAccounts('all', 0); }}
                >
                  {s === 'all' ? 'الكل' : s === 'pending' ? 'انتظار' : s === 'approved' ? 'موافق' : s === 'rejected' ? 'مرفوض' : 'محذوف'}
                </button>
              ))}
            </div>
          )}

          {accountAction && (
            <div className="s-report-section" style={{ marginBottom: 'var(--ak-space-3)', background: 'var(--ak-crimson-bg-muted)', border: '1px solid var(--ak-border-red)', borderRadius: 'var(--ak-radius-md)', padding: 'var(--ak-space-3)' }}>
              <p style={{ marginBottom: 'var(--ak-space-2)' }}>
                تأكيد إجراء <strong style={{ color: 'var(--ak-crimson-action)' }}>
                  {accountAction.action === 'approve' ? 'موافقة' : accountAction.action === 'reject' ? 'رفض' : 'حذف'}
                </strong> على الحساب رقم {accountAction.id}؟
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

          <div className="s-admin-event-table-scroll">
            <table className="s-admin-event-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>الاسم</th>
                  <th>الحالة</th>
                  <th>الألعاب</th>
                  <th>تاريخ الإنشاء</th>
                  <th>إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {accountsLoading && accounts.accounts.length === 0 ? (
                  <tr><td colSpan="6"><div className="shimmer" style={{ height: '6rem' }} aria-hidden="true" /></td></tr>
                ) : accounts.accounts.length === 0 ? (
                  <tr>
                    <td colSpan="6" style={{ textAlign: 'center', color: 'var(--ak-text-muted)', padding: 'var(--ak-space-4)' }}>
                      {accountsView === 'pending' ? 'ما فيش حسابات بانتظار الموافقة.' : 'ما فيش حسابات مطابقة.'}
                    </td>
                  </tr>
                ) : accounts.accounts.map(a => (
                  <tr key={a.id}>
                    <td>{a.id}</td>
                    <td>
                      {a.username || '—'}
                      {a.isAdmin && <span className="s-admin-pill" style={{ marginInlineStart: '0.4rem' }}>مشرف</span>}
                      {a.isGuest && <span className="s-admin-pill" style={{ marginInlineStart: '0.4rem', opacity: 0.6 }}>ضيف</span>}
                    </td>
                    <td>
                      <span style={{
                        color: a.status === 'pending' ? 'var(--ak-gold)' :
                               a.status === 'approved' ? 'var(--ak-text-strong)' :
                               a.status === 'rejected' ? 'var(--ak-crimson-action)' : 'var(--ak-text-muted)',
                      }}>
                        {a.status === 'pending' ? 'انتظار' : a.status === 'approved' ? 'موافق' : a.status === 'rejected' ? 'مرفوض' : 'محذوف'}
                      </span>
                    </td>
                    <td>{a.gamesPlayed}</td>
                    <td>{a.createdAt ? a.createdAt.slice(0, 10) : '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {(a.status === 'pending' || a.status === 'rejected') && !a.isAdmin && (
                          <button
                            type="button"
                            className="s-admin-pill"
                            style={{ color: 'var(--ak-text-strong)', cursor: 'pointer' }}
                            onClick={() => setAccountAction({ id: a.id, action: 'approve' })}
                          >
                            موافقة
                          </button>
                        )}
                        {a.status !== 'rejected' && a.status !== 'deleted' && !a.isAdmin && (
                          <button
                            type="button"
                            className="s-admin-pill"
                            style={{ color: 'var(--ak-crimson-action)', cursor: 'pointer' }}
                            onClick={() => setAccountAction({ id: a.id, action: 'reject' })}
                          >
                            رفض
                          </button>
                        )}
                        {a.status !== 'deleted' && !a.isAdmin && (
                          <button
                            type="button"
                            className="s-admin-pill"
                            style={{ color: 'var(--ak-text-muted)', cursor: 'pointer' }}
                            onClick={() => setAccountAction({ id: a.id, action: 'delete' })}
                          >
                            حذف
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {accountsView === 'all' && accounts.total > USERS_PAGE_SIZE && (
            <div className="s-admin-pagination">
              <button
                type="button"
                className="s-admin-pill"
                disabled={accountsOffset === 0 || accountsLoading}
                onClick={() => loadAccounts('all', Math.max(0, accountsOffset - USERS_PAGE_SIZE))}
              >
                السابق
              </button>
              <span>
                {accountsOffset + 1}–{Math.min(accountsOffset + USERS_PAGE_SIZE, accounts.total)} من {accounts.total}
              </span>
              <button
                type="button"
                className="s-admin-pill"
                disabled={accountsOffset + USERS_PAGE_SIZE >= accounts.total || accountsLoading}
                onClick={() => loadAccounts('all', accountsOffset + USERS_PAGE_SIZE)}
              >
                التالي
              </button>
            </div>
          )}

          <div style={{ marginTop: 'var(--ak-space-3)', textAlign: 'end' }}>
            <AkButton variant="ghost" onClick={() => loadAccounts(accountsView, accountsOffset)} disabled={accountsLoading}>
              تحديث
            </AkButton>
          </div>
        </section>
      )}

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

      {tab === 'users' && (
        <section className="s-admin-section">
          <div className="s-admin-rangepicker-inputs" style={{ marginBottom: 'var(--ak-space-3)' }}>
            <label className="s-admin-rangepicker-field" style={{ flex: 1 }}>
              <span>البحث</span>
              <input
                type="text"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="اسم مستخدم"
              />
            </label>
            <AkButton variant="ghost" onClick={() => loadUsers(0)} disabled={usersLoading}>
              بحث
            </AkButton>
          </div>
          {usersError && (
            <div className="s-auth-error" style={{ marginBottom: 'var(--ak-space-3)' }}>{usersError}</div>
          )}
          <div className="s-admin-event-table-scroll">
            <table className="s-admin-event-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>الاسم</th>
                  <th>نوع الحساب</th>
                  <th>الألعاب</th>
                  <th>تاريخ الإنشاء</th>
                </tr>
              </thead>
              <tbody>
                {usersLoading && users.users.length === 0 ? (
                  <tr><td colSpan="5"><div className="shimmer" style={{ height: '6rem' }} aria-hidden="true" /></td></tr>
                ) : users.users.length === 0 ? (
                  <tr>
                    <td colSpan="5" style={{ textAlign: 'center', color: 'var(--ak-text-muted)', padding: 'var(--ak-space-4)' }}>
                      ما فيش مستخدمين مطابقين.
                    </td>
                  </tr>
                ) : users.users.map(u => (
                  <tr key={u.id}>
                    <td>{u.id}</td>
                    <td>
                      {u.username || '—'}
                      {u.isAdmin && <span className="s-admin-pill" style={{ marginInlineStart: '0.4rem' }}>مشرف</span>}
                    </td>
                    <td>{u.isGuest ? 'ضيف' : 'مسجَّل'}</td>
                    <td>{u.gamesPlayed}</td>
                    <td>{u.createdAt ? u.createdAt.slice(0, 10) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="s-admin-pagination">
            <button
              type="button"
              className="s-admin-pill"
              disabled={userOffset === 0 || usersLoading}
              onClick={() => loadUsers(Math.max(0, userOffset - USERS_PAGE_SIZE))}
            >
              السابق
            </button>
            <span>
              {userOffset + 1}–{Math.min(userOffset + USERS_PAGE_SIZE, users.total)} من {users.total}
            </span>
            <button
              type="button"
              className="s-admin-pill"
              disabled={userOffset + USERS_PAGE_SIZE >= users.total || usersLoading}
              onClick={() => loadUsers(userOffset + USERS_PAGE_SIZE)}
            >
              التالي
            </button>
          </div>
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
        <div style={{ color: 'var(--ak-text-muted)', padding: 'var(--ak-space-3)' }}>
          ما فيش بيانات.
        </div>
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
