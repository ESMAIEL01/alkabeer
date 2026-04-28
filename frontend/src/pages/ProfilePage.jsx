import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getStoredUser } from '../services/api';
import AvatarMark from '../components/AvatarMark';
import StatsGrid from '../components/StatsGrid';
import MatchHistoryRow from '../components/MatchHistoryRow';
import AkButton from '../components/AkButton';
import {
  getProfileInsight,
  getRoleTendency,
  formatRoleTendency,
  formatStatLabel,
} from '../lib/profileInsight';

const HISTORY_PAGE_SIZE = 10;

// FixPack v3 / Commit 2 — guided identity interview questions. Stable
// questionIds so the backend can correlate answers across requests.
const INTERVIEW_QUESTIONS = [
  { id: 'play_style',  question: 'بتحب تلعب بهدوء ولا تواجه الناس مباشرة؟' },
  { id: 'defense',     question: 'لما تتهم، بتدافع بعقل ولا بتقلب الطاولة؟' },
  { id: 'persona',     question: 'تحب تظهر في اللعبة كشخص غامض، محقق، مخادع، ولا شاهد بريء؟' },
  { id: 'memorable',   question: 'إيه أكتر تفصيلة تحب الناس تفتكرك بيها؟' },
  { id: 'one_line',    question: 'في جملة واحدة، إيه أسلوبك في اللعب؟' },
  { id: 'tone_choice', question: 'تحب هويتك تكون فخمة، مرعبة، ساخرة، ولا هادئة؟' },
];

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

  // FixPack v3 / Commit 2 — guided identity interview state. Mirrors the
  // bio-writer pattern: no AI call on mount, only on user click; duplicate
  // clicks blocked while busy; preview is shown but never auto-persisted.
  const [interviewOpen, setInterviewOpen] = useState(false);
  const [interviewAnswers, setInterviewAnswers] = useState(
    () => INTERVIEW_QUESTIONS.map(() => '')
  );
  const [interviewBusy, setInterviewBusy] = useState(false);
  const [interviewError, setInterviewError] = useState('');
  const [interviewPreview, setInterviewPreview] = useState(null); // { bio, title, tone, motto, playStyleSummary, source }
  // Commit 3: small confirmation toast after the user copies the bio
  // into the draft so the action feels acknowledged without auto-saving.
  const [interviewBioCopied, setInterviewBioCopied] = useState(false);

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

  // FixPack v3 / Commit 2 — guided identity interview handlers.
  const openInterview = () => {
    setInterviewOpen(true);
    setInterviewError('');
  };
  const closeInterview = () => {
    setInterviewOpen(false);
    setInterviewError('');
    setInterviewPreview(null);
  };
  const setInterviewAnswerAt = (idx, value) => {
    setInterviewAnswers(prev => {
      const next = prev.slice();
      next[idx] = value;
      return next;
    });
  };

  const generateIdentity = async () => {
    if (interviewBusy) return;
    setInterviewBusy(true);
    setInterviewError('');
    setInterviewPreview(null);
    // Build the answers payload with the canonical question text + id so
    // the backend prompt has full context. Empty answers are dropped
    // before the request — the server still enforces 3..6.
    const answers = INTERVIEW_QUESTIONS
      .map((q, i) => ({
        questionId: q.id,
        question: q.question,
        answer: (interviewAnswers[i] || '').trim(),
      }))
      .filter(a => a.answer.length > 0);
    if (answers.length < 3) {
      setInterviewError('جاوب على 3 أسئلة على الأقل عشان الكبير يقدر يصيغ هويتك.');
      setInterviewBusy(false);
      return;
    }
    try {
      const resp = await api.post('/api/profile/identity/interview', { answers });
      if (resp && resp.bio && resp.title) {
        setInterviewPreview({
          bio: resp.bio,
          title: resp.title,
          tone: resp.tone,
          motto: resp.motto,
          playStyleSummary: resp.playStyleSummary,
          source: resp.source || 'fallback',
        });
      } else {
        setInterviewError('الكبير ما رجّعش هوية صالحة. حاول تاني.');
      }
    } catch (err) {
      setInterviewError(err.message || 'تعذّر التواصل مع الكبير دلوقتي.');
    } finally {
      setInterviewBusy(false);
    }
  };

  const useInterviewBio = () => {
    if (!interviewPreview) return;
    // Open edit mode if not already, then copy the bio into the draft.
    // Title / tone / motto / playStyleSummary are PREVIEW-only — they are
    // intentionally not persisted (no schema for them in user_profiles).
    // The preview stays visible after copying so the user can also copy
    // the title / motto / playStyleSummary to clipboard if they want
    // to keep them somewhere else.
    if (!editing) {
      beginEdit();
      setDraft(d => ({
        ...d,
        bio: interviewPreview.bio,
        // beginEdit uses the current profile values; reapply the bio
        // override on the next tick via state-merge.
      }));
    } else {
      setDraft(d => ({ ...d, bio: interviewPreview.bio }));
    }
    setInterviewError('');
    setInterviewBioCopied(true);
    // Auto-clear the toast after a few seconds. State-only, no DB.
    setTimeout(() => setInterviewBioCopied(false), 3500);
  };

  const ignoreInterview = () => {
    setInterviewPreview(null);
    setInterviewError('');
    setInterviewBioCopied(false);
  };

  // Commit 3 — copy a single field (title / motto / etc.) to clipboard.
  // Best-effort: navigator.clipboard is gated by HTTPS and user gesture;
  // when unavailable we silently no-op rather than spam the user.
  const copyToClipboard = (text) => {
    try {
      if (typeof text !== 'string' || !text) return;
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    } catch { /* swallow */ }
  };

  // Commit 3 — clear avatar URL inline from the edit form.
  const clearAvatar = () => {
    setDraft(d => ({ ...d, avatarUrl: '' }));
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

  // Commit 3 — derived: top-3 history rows for the prominent strip, and
  // deterministic insight strings from the live stats snapshot.
  const top3History = useMemo(
    () => (Array.isArray(history) ? history.slice(0, 3) : []),
    [history]
  );
  const insightLine = useMemo(() => getProfileInsight(stats), [stats]);
  const roleTendencyLabel = useMemo(
    () => formatRoleTendency(getRoleTendency(stats)),
    [stats]
  );

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
            {!loading && stats && (
              <span className="s-profile-tendency-tag">{roleTendencyLabel}</span>
            )}
          </p>
          {profile && profile.bio && !editing && (
            <p className="s-profile-bio">{profile.bio}</p>
          )}
          {(!profile || !profile.bio) && !editing && (
            <p className="s-profile-bio s-profile-bio-empty">
              لسه مفيش سيرة. اضغط "تعديل" واكتب سطرين عنك أو خلي الكبير يصيغ هويتك من قسم
              "اصنع هويتك في Mafiozo" تحت.
            </p>
          )}
          {!loading && stats && (
            <div className="s-profile-hero-chips" aria-label="ملخص سريع">
              <span className="s-profile-chip">
                <span className="s-profile-chip-label">مباريات</span>
                <strong>{formatStatLabel(stats.gamesPlayed)}</strong>
              </span>
              <span className="s-profile-chip">
                <span className="s-profile-chip-label">نسبة الانتصار</span>
                <strong>{formatStatLabel(stats.winRate)}%</strong>
              </span>
              <span className="s-profile-chip">
                <span className="s-profile-chip-label">جولات النجاة</span>
                <strong>{formatStatLabel(stats.totalSurvivalRounds)}</strong>
              </span>
            </div>
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
              <span>رابط صورة HTTPS</span>
              <div className="s-profile-avatar-row">
                <AvatarMark
                  src={draft.avatarUrl}
                  name={(draft.displayName || (user && user.username) || '')}
                  size={64}
                />
                <input
                  type="url"
                  value={draft.avatarUrl}
                  onChange={(e) => setDraft(d => ({ ...d, avatarUrl: e.target.value }))}
                  placeholder="https://example.com/avatar.png"
                  maxLength={520}
                  inputMode="url"
                  style={{ flex: 1, minWidth: 0 }}
                />
                <AkButton
                  variant="ghost"
                  type="button"
                  onClick={clearAvatar}
                  disabled={saving || !draft.avatarUrl}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  مسح الصورة
                </AkButton>
              </div>
              <small style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-caption)' }}>
                حط رابط صورة شخصية أو رمز يعبر عنك. لازم يبدأ بـ https://. اتركه فاضي وامسح
                لو حابب ترجع لرمزك التلقائي.
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

      {/* FixPack v3 / Commit 2 — guided AI identity interview.
          Always visible (collapsed by default). No AI call fires until
          the user explicitly clicks "اصنع هويتي" — keeps page mount
          responsive. Output is a preview only; nothing auto-persists. */}
      <section className="s-profile-section s-identity-section">
        <div className="s-profile-section-head">
          <span className="ak-overline">Identity · هوية اللاعب</span>
          {!interviewOpen && (
            <AkButton variant="ghost" type="button" onClick={openInterview}>
              ابدأ المقابلة
            </AkButton>
          )}
          {interviewOpen && (
            <AkButton variant="ghost" type="button" onClick={closeInterview}>
              إخفاء
            </AkButton>
          )}
        </div>
        <h2 className="s-profile-section-title">اصنع هويتك في Mafiozo</h2>
        <p className="s-identity-intro">
          جاوب على شوية أسئلة قصيرة، والكبير هيقترح عليك بايو ولقب ونبرة وشعار. ولا حاجة هتتحفظ تلقائياً —
          إنت اللي بتقرر تستخدمها أو تتجاهلها.
        </p>

        {interviewOpen && (
          <div className="s-identity-form">
            {INTERVIEW_QUESTIONS.map((q, i) => (
              <label key={q.id} className="s-identity-question">
                <span className="s-identity-q-num">{i + 1}.</span>
                <span className="s-identity-q-text">{q.question}</span>
                <textarea
                  rows={2}
                  value={interviewAnswers[i]}
                  onChange={(e) => setInterviewAnswerAt(i, e.target.value)}
                  maxLength={200}
                  placeholder="اكتب إجابة قصيرة (2 لـ 180 حرف)"
                  disabled={interviewBusy}
                />
                <small className="s-identity-q-counter">
                  {(interviewAnswers[i] || '').trim().length} / 180
                </small>
              </label>
            ))}

            {interviewError && (
              <div className="s-profile-banner err" style={{ marginTop: 'var(--ak-space-2)' }}>
                ⚠ {interviewError}
              </div>
            )}

            <div className="s-identity-cta">
              <AkButton
                variant="primary"
                type="button"
                onClick={generateIdentity}
                disabled={interviewBusy}
              >
                {interviewBusy ? 'الكبير بيصيغ هويتك...' : 'اصنع هويتي'}
              </AkButton>
            </div>

            {interviewPreview && (
              <div className="s-identity-preview">
                <div className="s-bio-ai-preview-head">
                  <span className="ak-overline">اقتراح الكبير</span>
                  <span style={{ font: 'var(--ak-t-caption)', color: 'var(--ak-text-muted)' }}>
                    {interviewPreview.source === 'gemini'      ? 'مصدر: Gemini'
                      : interviewPreview.source === 'openrouter' ? 'مصدر: OpenRouter'
                      : 'مصدر: نص احتياطي'}
                  </span>
                </div>

                <p className="s-identity-preview-note">
                  معاينة من جلسة الهوية. استخدم البايو للحفظ، وانسخ اللقب أو الشعار لو حبيت.
                </p>

                <div className="s-identity-preview-grid">
                  <div className="s-identity-preview-cell">
                    <span className="ak-overline">اللقب</span>
                    <p className="s-identity-preview-value">{interviewPreview.title}</p>
                    <button
                      type="button"
                      className="s-identity-copy-btn"
                      onClick={() => copyToClipboard(interviewPreview.title)}
                      title="نسخ اللقب"
                    >
                      نسخ
                    </button>
                  </div>
                  <div className="s-identity-preview-cell">
                    <span className="ak-overline">النبرة</span>
                    <p className="s-identity-preview-value">{interviewPreview.tone}</p>
                    <button
                      type="button"
                      className="s-identity-copy-btn"
                      onClick={() => copyToClipboard(interviewPreview.tone)}
                      title="نسخ النبرة"
                    >
                      نسخ
                    </button>
                  </div>
                  <div className="s-identity-preview-cell s-identity-preview-cell-wide">
                    <span className="ak-overline">الشعار</span>
                    <p className="s-identity-preview-value">«{interviewPreview.motto}»</p>
                    <button
                      type="button"
                      className="s-identity-copy-btn"
                      onClick={() => copyToClipboard(interviewPreview.motto)}
                      title="نسخ الشعار"
                    >
                      نسخ
                    </button>
                  </div>
                  <div className="s-identity-preview-cell s-identity-preview-cell-wide">
                    <span className="ak-overline">أسلوب اللعب</span>
                    <p className="s-identity-preview-value">{interviewPreview.playStyleSummary}</p>
                    <button
                      type="button"
                      className="s-identity-copy-btn"
                      onClick={() => copyToClipboard(interviewPreview.playStyleSummary)}
                      title="نسخ أسلوب اللعب"
                    >
                      نسخ
                    </button>
                  </div>
                  <div className="s-identity-preview-cell s-identity-preview-cell-wide">
                    <span className="ak-overline">السيرة المقترحة</span>
                    <p className="s-identity-preview-value">{interviewPreview.bio}</p>
                  </div>
                </div>

                {interviewBioCopied && (
                  <div className="s-identity-toast" role="status">
                    ✓ نسخت السيرة في حقل "سيرة قصيرة". اضغط "حفظ" لما تكون جاهز.
                  </div>
                )}

                <div className="s-bio-ai-preview-actions">
                  <AkButton variant="primary" type="button" onClick={useInterviewBio} disabled={saving}>
                    استخدم البايو
                  </AkButton>
                  <AkButton variant="ghost" type="button" onClick={generateIdentity} disabled={interviewBusy || saving}>
                    إعادة الصياغة
                  </AkButton>
                  <AkButton variant="ghost" type="button" onClick={ignoreInterview} disabled={saving}>
                    تجاهل
                  </AkButton>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Stats grid + deterministic insight line (Commit 3) */}
      <section className="s-profile-section">
        <span className="ak-overline">Stats · إحصائيات</span>
        <h2 className="s-profile-section-title">الإحصائيات</h2>
        {loading
          ? <div className="shimmer" style={{ height: 140 }} aria-hidden />
          : (
            <>
              <StatsGrid stats={stats} />
              <p className="s-profile-insight" aria-live="polite">{insightLine}</p>
            </>
          )
        }
      </section>

      {/* Match history (Commit 3 — prominent recent-3 strip) */}
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
            <p className="s-profile-empty-title">الأرشيف فاضي لسه.</p>
            <p className="s-profile-empty-sub">
              العب أول قضية عشان تظهر شخصيتك الحقيقية.
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
            {historyOffset === 0 && top3History.length > 0 && (
              <div className="s-history-recent">
                <span className="ak-overline">آخر 3 قضايا</span>
                <div className="s-history-list s-history-list-recent">
                  {top3History.map(g => <MatchHistoryRow key={g.id} game={g} />)}
                </div>
                {history.length > top3History.length && (
                  <span className="s-history-recent-divider" aria-hidden>·</span>
                )}
              </div>
            )}
            <div className="s-history-list">
              {(historyOffset === 0 ? history.slice(top3History.length) : history)
                .map(g => <MatchHistoryRow key={g.id} game={g} />)}
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
