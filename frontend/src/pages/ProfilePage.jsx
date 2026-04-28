import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getStoredUser } from '../services/api';
import AvatarMark from '../components/AvatarMark';
import StatsGrid from '../components/StatsGrid';
import MatchHistoryRow from '../components/MatchHistoryRow';
import AkButton from '../components/AkButton';

const HISTORY_PAGE_SIZE = 10;

/**
 * ProfilePage — Mafiozo player dashboard.
 *
 * Loads on mount:
 *   GET /api/profile/me     → { user, profile, stats }
 *   GET /api/history/me     → paginated games + total
 *
 * Edit mode opens an inline form for displayName / avatarUrl / bio,
 * persisted via PUT /api/profile/me. Cancel discards local edits and
 * restores the last server snapshot. Saving is optimistic — the
 * server response replaces local state on success.
 *
 * Privacy: this page never renders the JWT, password, or any other
 * user's data. The history list comes from /api/history/me which is
 * already filtered by req.user.id; the archive replay link is gated
 * on the backend.
 */

export default function ProfilePage() {
  const navigate = useNavigate();
  const storedUser = getStoredUser();

  // Server-truth slots.
  const [user, setUser] = useState(storedUser || null);
  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  // Edit-mode local copy (mirrors profile while editing).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ displayName: '', avatarUrl: '', bio: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  // Match history.
  const [history, setHistory] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');

  // D5 — AI bio writer state. Independent of save state so user can
  // iterate freely without affecting the underlying form.
  const [aiBioBusy, setAiBioBusy] = useState(false);
  const [aiBioPreview, setAiBioPreview] = useState(null);  // { bio, source }
  const [aiBioError, setAiBioError] = useState('');

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.get('/api/profile/me');
      if (data && data.user) setUser(data.user);
      setProfile(data && data.profile ? data.profile : null);
      setStats(data && data.stats ? data.stats : null);
    } catch (err) {
      setLoadError(err.message || 'تعذّر تحميل الملف الشخصي.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async (offset = 0) => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const data = await api.get(`/api/history/me?limit=${HISTORY_PAGE_SIZE}&offset=${offset}`);
      setHistory(Array.isArray(data && data.games) ? data.games : []);
      setHistoryTotal(typeof (data && data.total) === 'number' ? data.total : 0);
      setHistoryOffset(typeof (data && data.offset) === 'number' ? data.offset : offset);
    } catch (err) {
      setHistoryError(err.message || 'تعذّر تحميل المباريات السابقة.');
      setHistory([]);
      setHistoryTotal(0);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProfile();
    loadHistory(0);
  }, [loadProfile, loadHistory]);

  const beginEdit = () => {
    setDraft({
      displayName: profile && profile.displayName ? profile.displayName : '',
      avatarUrl:   profile && profile.avatarUrl   ? profile.avatarUrl   : '',
      bio:         profile && profile.bio         ? profile.bio         : '',
    });
    setSaveError('');
    setSavedFlash(false);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setSaveError('');
    setAiBioPreview(null);
    setAiBioError('');
  };

  // D5 — AI bio writer. Uses the current bio textarea contents as the
  // rough idea. Never overwrites the bio automatically; the user has
  // to press "استخدم النص" to copy the suggestion into the textarea.
  const requestAiBio = async () => {
    setAiBioBusy(true);
    setAiBioError('');
    setAiBioPreview(null);
    const rawIdea = (draft.bio || '').trim();
    if (rawIdea.length < 10) {
      setAiBioError('اكتب فكرة مختصرة (10 حروف على الأقل) عشان الكبير يقدر يعيد صياغتها.');
      setAiBioBusy(false);
      return;
    }
    try {
      const resp = await api.post('/api/profile/bio/ai', { rawIdea });
      if (resp && typeof resp.bio === 'string' && resp.bio.length > 0) {
        setAiBioPreview({ bio: resp.bio, source: resp.source || 'fallback' });
      } else {
        setAiBioError('الكبير ما رجّعش نص صالح. حاول تاني.');
      }
    } catch (err) {
      setAiBioError(err.message || 'تعذّر التواصل مع الكبير دلوقتي.');
    } finally {
      setAiBioBusy(false);
    }
  };

  const acceptAiBio = () => {
    if (!aiBioPreview) return;
    setDraft(d => ({ ...d, bio: aiBioPreview.bio }));
    setAiBioPreview(null);
    setAiBioError('');
  };

  const rejectAiBio = () => {
    setAiBioPreview(null);
    setAiBioError('');
  };

  const saveEdit = async (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    setSaving(true);
    setSaveError('');
    setSavedFlash(false);
    try {
      // Build payload: only include fields the user actually changed
      // (tolerates "" for avatarUrl/bio as the documented clear path).
      const payload = {};
      const dn = draft.displayName.trim();
      if (dn.length > 0) payload.displayName = dn;
      // For avatarUrl / bio, send the trimmed value (empty string clears).
      payload.avatarUrl = draft.avatarUrl.trim();
      payload.bio = draft.bio.trim();

      const data = await api.put('/api/profile/me', payload);
      if (data && data.profile) setProfile(data.profile);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
      setEditing(false);
    } catch (err) {
      setSaveError(err.message || 'تعذّر حفظ التعديلات.');
    } finally {
      setSaving(false);
    }
  };

  // Pagination helpers.
  const hasNext = historyOffset + HISTORY_PAGE_SIZE < historyTotal;
  const hasPrev = historyOffset > 0;
  const pageNum = Math.floor(historyOffset / HISTORY_PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));

  if (!storedUser) {
    return (
      <div className="s-profile-empty">
        <h2>غير مسجّل دخول</h2>
        <button className="ak-btn ak-btn-primary" onClick={() => navigate('/')}>اذهب لتسجيل الدخول</button>
      </div>
    );
  }

  return (
    <div className="s-profile">
      {/* Top nav: back to lobby */}
      <div className="s-profile-topbar">
        <span className="ak-overline">Profile · ملفك في الأرشيف</span>
        <AkButton variant="ghost" onClick={() => navigate('/lobby')}>عودة للساحة</AkButton>
      </div>

      {loadError && <div className="s-profile-banner err">⚠ {loadError}</div>}

      {/* Hero card: avatar + identity */}
      <section className="s-profile-hero">
        <AvatarMark
          src={profile && profile.avatarUrl}
          name={(profile && profile.displayName) || (user && user.username) || ''}
          size={128}
        />
        <div className="s-profile-id">
          <h1 className="s-profile-name">
            {(profile && profile.displayName) || (user && user.username) || '—'}
          </h1>
          <p className="s-profile-username">
            <span className="ak-overline">@{user ? user.username : '—'}</span>
            {user && user.isGuest && <span className="s-profile-guest-tag">حساب ضيف</span>}
          </p>
          {profile && profile.bio && !editing && (
            <p className="s-profile-bio">{profile.bio}</p>
          )}
          {(!profile || !profile.bio) && !editing && (
            <p className="s-profile-bio s-profile-bio-empty">
              لسه مفيش سيرة. اضغط "تعديل" واكتب سطرين عن نفسك.
            </p>
          )}
        </div>
        <div className="s-profile-hero-cta">
          {!editing && <AkButton variant="primary" onClick={beginEdit}>تعديل الملف</AkButton>}
          {savedFlash && <span className="s-profile-saved-flash">✓ تم الحفظ</span>}
        </div>
      </section>

      {/* Edit form */}
      {editing && (
        <section className="s-profile-edit">
          <span className="ak-overline">تعديل الملف</span>
          {saveError && <div className="s-profile-banner err">⚠ {saveError}</div>}
          <form onSubmit={saveEdit}>
            <label className="s-profile-field">
              <span>اسم العرض</span>
              <input
                type="text"
                value={draft.displayName}
                onChange={(e) => setDraft(d => ({ ...d, displayName: e.target.value }))}
                placeholder="من 2 لـ 32 حرف"
                maxLength={64}
              />
            </label>
            <label className="s-profile-field">
              <span>رابط الصورة (https فقط)</span>
              <input
                type="url"
                value={draft.avatarUrl}
                onChange={(e) => setDraft(d => ({ ...d, avatarUrl: e.target.value }))}
                placeholder="https://example.com/avatar.png"
                maxLength={520}
                inputMode="url"
              />
              <small style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-caption)' }}>
                اتركه فاضي عشان تمسح الصورة الحالية.
              </small>
            </label>
            <label className="s-profile-field">
              <span>سيرة قصيرة</span>
              <textarea
                rows={4}
                value={draft.bio}
                onChange={(e) => setDraft(d => ({ ...d, bio: e.target.value }))}
                placeholder="جملتين عن أسلوبك في اللعب."
                maxLength={520}
              />
              <small style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-caption)' }}>
                {draft.bio.trim().length} / 500
              </small>
              <div className="s-bio-ai-block">
                <AkButton
                  variant="ghost"
                  type="button"
                  onClick={requestAiBio}
                  disabled={aiBioBusy || saving}
                >
                  {aiBioBusy ? 'الكبير بيكتب...' : 'اكتبها بأسلوب Mafiozo'}
                </AkButton>
                {aiBioError && (
                  <div className="s-profile-banner err" style={{ marginTop: 'var(--ak-space-2)' }}>
                    ⚠ {aiBioError}
                  </div>
                )}
                {aiBioPreview && (
                  <div className="s-bio-ai-preview">
                    <div className="s-bio-ai-preview-head">
                      <span className="ak-overline">اقتراح الكبير</span>
                      <span style={{ font: 'var(--ak-t-caption)', color: 'var(--ak-text-muted)' }}>
                        {aiBioPreview.source === 'gemini'      ? 'مصدر: Gemini'
                          : aiBioPreview.source === 'openrouter' ? 'مصدر: OpenRouter'
                          : 'مصدر: نص احتياطي'}
                      </span>
                    </div>
                    <div>{aiBioPreview.bio}</div>
                    <div className="s-bio-ai-preview-actions">
                      <AkButton variant="primary" type="button" onClick={acceptAiBio} disabled={saving}>
                        استخدم النص
                      </AkButton>
                      <AkButton variant="ghost" type="button" onClick={rejectAiBio} disabled={saving}>
                        تجاهل
                      </AkButton>
                    </div>
                  </div>
                )}
              </div>
            </label>
            <div className="s-profile-edit-actions">
              <AkButton variant="primary" type="submit" disabled={saving}>
                {saving ? 'يتم الحفظ...' : 'حفظ'}
              </AkButton>
              <AkButton variant="ghost" type="button" onClick={cancelEdit} disabled={saving}>
                إلغاء
              </AkButton>
            </div>
          </form>
        </section>
      )}

      {/* Stats grid */}
      <section className="s-profile-section">
        <span className="ak-overline">Stats · إحصائيات</span>
        <h2 className="s-profile-section-title">الإحصائيات</h2>
        {loading
          ? <div className="shimmer" style={{ height: 140 }} aria-hidden />
          : <StatsGrid stats={stats} />
        }
      </section>

      {/* Match history */}
      <section className="s-profile-section">
        <div className="s-profile-section-head">
          <span className="ak-overline">History · سجل المباريات</span>
          <span className="s-profile-section-count">
            {historyTotal} {historyTotal === 1 ? 'لعبة' : 'مباريات'}
          </span>
        </div>
        <h2 className="s-profile-section-title">المباريات السابقة</h2>

        {historyError && <div className="s-profile-banner err">⚠ {historyError}</div>}

        {historyLoading && (
          <div className="shimmer" style={{ height: 200 }} aria-hidden />
        )}

        {!historyLoading && history.length === 0 && !historyError && (
          <div className="s-profile-empty-state">
            <p className="s-profile-empty-title">لا توجد مباريات محفوظة بعد</p>
            <p className="s-profile-empty-sub">
              ابدأ لعبة كاملة لحد ما توصل للكشف النهائي عشان تظهر هنا.
            </p>
            <div style={{ marginTop: 'var(--ak-space-3)' }}>
              <AkButton variant="primary" onClick={() => navigate('/lobby')}>
                ابدأ لعبة جديدة
              </AkButton>
            </div>
          </div>
        )}

        {!historyLoading && history.length > 0 && (
          <>
            <div className="s-history-list">
              {history.map(g => <MatchHistoryRow key={g.id} game={g} />)}
            </div>
            {historyTotal > HISTORY_PAGE_SIZE && (
              <div className="s-history-pager">
                <AkButton
                  variant="ghost"
                  disabled={!hasPrev || historyLoading}
                  onClick={() => loadHistory(Math.max(0, historyOffset - HISTORY_PAGE_SIZE))}
                >
                  السابق
                </AkButton>
                <span className="s-history-page-indicator">
                  صفحة {pageNum} من {totalPages}
                </span>
                <AkButton
                  variant="ghost"
                  disabled={!hasNext || historyLoading}
                  onClick={() => loadHistory(historyOffset + HISTORY_PAGE_SIZE)}
                >
                  التالي
                </AkButton>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
