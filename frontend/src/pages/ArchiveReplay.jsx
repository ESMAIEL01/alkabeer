import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import AkButton from '../components/AkButton';

/**
 * ArchiveReplay — read-only post-game review for participants.
 *
 * GET /api/archive/:gameId. Backend gates on game_participants; the
 * page renders the sanitized payload as-is. Loading, 403, 404, and
 * generic error states each get a calm noir card. No raw archive_b64,
 * no JWT, no other-user data — the backend already filters all of that.
 */

const ROLE_LABEL = {
  mafiozo:         'المافيوزو',
  obvious_suspect: 'المشتبه الواضح',
  innocent:        'بريء',
};
const OUTCOME_LABEL = {
  investigators_win: 'انتصر التحقيق',
  mafiozo_survives:  'المافيوزو نجى',
  aborted:           'تم إنهاء الجلسة',
};
const MODE_LABEL = {
  AI:    'مضيف افتراضي',
  HUMAN: 'مضيف بشري',
};
const REVEAL_LABEL = {
  normal: 'عادي',
  blind:  'عمياني',
};

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

export default function ArchiveReplay() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);   // { kind: 'forbidden'|'notfound'|'generic', message }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get(`/api/archive/${encodeURIComponent(gameId)}`)
      .then((d) => {
        if (cancelled) return;
        setData(d || null);
      })
      .catch((err) => {
        if (cancelled) return;
        const status = err && err.status;
        if (status === 403) setError({ kind: 'forbidden', message: err.message });
        else if (status === 404) setError({ kind: 'notfound', message: err.message });
        else setError({ kind: 'generic', message: (err && err.message) || 'تعذّر تحميل الأرشيف.' });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [gameId]);

  if (loading) {
    return (
      <div className="s-archive">
        <div className="shimmer" style={{ height: 180 }} aria-hidden />
        <div className="shimmer" style={{ height: 220 }} aria-hidden />
      </div>
    );
  }

  if (error) {
    const title =
      error.kind === 'forbidden' ? 'مش مسموح لك تشوف الأرشيف ده'
      : error.kind === 'notfound' ? 'الأرشيف مش موجود'
      : 'حصل خطأ';
    const sub =
      error.kind === 'forbidden' ? 'الأرشيف ده خاص باللاعبين اللي شاركوا في الجلسة.'
      : error.kind === 'notfound' ? 'الأرشيف اللي بتدوّر عليه مش موجود أو اتمسح.'
      : (error.message || 'جرب تاني بعد لحظات.');
    return (
      <div className="s-archive">
        <section className="s-archive-hero">
          <span className="ak-overline">Archive · أرشيف</span>
          <h1>{title}</h1>
          <p style={{ color: 'var(--ak-text-muted)' }}>{sub}</p>
          <div style={{ marginTop: 'var(--ak-space-4)' }}>
            <AkButton variant="ghost" onClick={() => navigate('/profile')}>عودة للملف الشخصي</AkButton>
          </div>
        </section>
      </div>
    );
  }

  const session = (data && data.session) || {};
  const caller = (data && data.caller) || {};
  const participants = Array.isArray(data && data.participants) ? data.participants : [];
  const votingHistory = Array.isArray(data && data.votingHistory) ? data.votingHistory : [];
  const finalReveal = (data && data.finalReveal) || null;

  return (
    <div className="s-archive">
      {/* HERO ----------------------------------------------------------- */}
      <section className="s-archive-hero">
        <span className="ak-overline">Archive · {session.id || gameId}</span>
        <h1>{session.scenarioTitle || 'قضية بدون عنوان'}</h1>
        <p style={{ color: 'var(--ak-text-muted)' }}>
          {OUTCOME_LABEL[session.outcome] || session.outcome || 'بدون نتيجة'}
          {session.endedAt ? ` · ${formatDate(session.endedAt)}` : ''}
        </p>
        <p style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-caption)' }}>
          {MODE_LABEL[session.hostMode] || session.hostMode || '—'}
          {' · '}
          {REVEAL_LABEL[session.revealMode] || session.revealMode || '—'}
        </p>
        <div style={{ marginTop: 'var(--ak-space-4)' }}>
          <AkButton variant="ghost" onClick={() => navigate('/profile')}>عودة للملف الشخصي</AkButton>
        </div>
      </section>

      {/* CALLER ROLE CARD ----------------------------------------------- */}
      <section className="s-archive-section">
        <span className="ak-overline">Your Role · دورك</span>
        <h2 className="s-archive-section-title">دورك في القضية</h2>
        <p style={{ color: 'var(--ak-text-main)', font: 'var(--ak-t-body)' }}>
          <strong>الدور:</strong>{' '}
          <span style={{ color: 'var(--ak-gold)' }}>
            {ROLE_LABEL[caller.role] || caller.role || '—'}
          </span>
        </p>
        {caller.storyCharacterName && (
          <p style={{ color: 'var(--ak-text-main)', font: 'var(--ak-t-body)' }}>
            <strong>الشخصية:</strong>{' '}
            {caller.storyCharacterName}
            {caller.storyCharacterRole ? ` (${caller.storyCharacterRole})` : ''}
          </p>
        )}
        <p style={{ color: 'var(--ak-text-main)', font: 'var(--ak-t-body)' }}>
          <strong>المصير:</strong>{' '}
          {caller.eliminatedAtRound
            ? `خرجت في الجولة ${caller.eliminatedAtRound}`
            : 'وصلت للنهاية'}
        </p>
        <p style={{ color: 'var(--ak-text-main)', font: 'var(--ak-t-body)' }}>
          <strong>النتيجة:</strong>{' '}
          {caller.wasWinner === true  ? 'فايز'
          : caller.wasWinner === false ? 'خسران'
          : '—'}
        </p>
      </section>

      {/* ROSTER --------------------------------------------------------- */}
      <section className="s-archive-section">
        <span className="ak-overline">Roster · اللاعبين</span>
        <h2 className="s-archive-section-title">قائمة اللاعبين</h2>
        {participants.length === 0
          ? <p style={{ color: 'var(--ak-text-muted)' }}>مفيش لاعبين متاحين في الأرشيف ده.</p>
          : (
            <ul className="s-archive-roster">
              {participants.map(p => (
                <li key={p.userId}>
                  <span className="name">
                    {p.username || '—'}
                    {p.wasHost ? ' · المضيف' : ''}
                  </span>
                  {p.gameRole && (
                    <span className="role">
                      {ROLE_LABEL[p.gameRole] || p.gameRole}
                    </span>
                  )}
                  {(p.storyCharacterName || p.storyCharacterRole) && (
                    <span className="meta">
                      {p.storyCharacterName || ''}
                      {p.storyCharacterRole ? ` · ${p.storyCharacterRole}` : ''}
                    </span>
                  )}
                  {p.eliminatedAtRound && (
                    <span className="meta">خرج في الجولة {p.eliminatedAtRound}</span>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </section>

      {/* VOTING TIMELINE ------------------------------------------------- */}
      <section className="s-archive-section">
        <span className="ak-overline">Voting · سجل التصويت</span>
        <h2 className="s-archive-section-title">جدول الجولات</h2>
        {votingHistory.length === 0
          ? <p style={{ color: 'var(--ak-text-muted)' }}>لا توجد جولات تصويت مسجّلة.</p>
          : (
            <div className="s-archive-timeline">
              {votingHistory.map((h, i) => {
                const cls = h.wasMafiozo ? 'caught' : h.eliminatedId ? 'elim' : '';
                return (
                  <div key={i} className={`s-archive-timeline-row ${cls}`}>
                    <span className="round">جولة {h.round || i + 1}</span>
                    <span className="who">
                      {h.eliminatedUsername
                        ? <>{h.eliminatedUsername}{h.wasMafiozo ? ' (المافيوزو)' : ''}</>
                        : 'لا أحد خرج'}
                    </span>
                    <span className="reason">{h.reason || '—'}</span>
                  </div>
                );
              })}
            </div>
          )
        }
      </section>

      {/* FINAL REVEAL --------------------------------------------------- */}
      <section className="s-archive-section">
        <span className="ak-overline">Final Reveal · الكشف النهائي</span>
        <h2 className="s-archive-section-title">الكشف النهائي</h2>
        {!finalReveal && (
          <p style={{ color: 'var(--ak-text-muted)' }}>الأرشيف غير مكتمل.</p>
        )}
        {finalReveal && finalReveal.headline && finalReveal.headline.title && (
          <h3 style={{ color: 'var(--ak-text-strong)', font: 'var(--ak-t-h3)', margin: '0 0 var(--ak-space-2)' }}>
            {finalReveal.headline.title}
          </h3>
        )}
        {finalReveal && finalReveal.headline && finalReveal.headline.subtitle && (
          <p style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-body)' }}>
            {finalReveal.headline.subtitle}
          </p>
        )}
        {finalReveal && finalReveal.caseSummary && finalReveal.caseSummary.story && (
          <p style={{ color: 'var(--ak-text-main)', font: 'var(--ak-t-body)', lineHeight: 1.7, marginTop: 'var(--ak-space-3)' }}>
            {finalReveal.caseSummary.story}
          </p>
        )}
        {finalReveal && finalReveal.caseSummary && finalReveal.caseSummary.closingLine && (
          <p style={{ color: 'var(--ak-gold)', font: 'var(--ak-t-body)', marginTop: 'var(--ak-space-3)', fontStyle: 'italic' }}>
            {finalReveal.caseSummary.closingLine}
          </p>
        )}
        {finalReveal && finalReveal.truth && (() => {
          // E3: prefer truth.mafiozos array; fall back to legacy singular fields.
          const mafiozos = Array.isArray(finalReveal.truth.mafiozos) && finalReveal.truth.mafiozos.length > 0
            ? finalReveal.truth.mafiozos
            : (finalReveal.truth.mafiozoUsername
                ? [{
                    username: finalReveal.truth.mafiozoUsername,
                    characterName: finalReveal.truth.mafiozoCharacterName,
                    explanation: finalReveal.truth.mafiozoExplanation,
                  }]
                : []);
          if (mafiozos.length === 0) return null;
          const isMulti = mafiozos.length > 1;
          return (
            <div style={{ marginTop: 'var(--ak-space-4)' }}>
              {isMulti && (
                <p style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-caption)', marginBottom: 'var(--ak-space-2)' }}>
                  {mafiozos.length} مافيوزو في القضية دي.
                </p>
              )}
              {mafiozos.map((m, i) => (
                <div key={m.playerId || i} style={{
                  marginTop: i > 0 ? 'var(--ak-space-3)' : 0,
                  padding: 'var(--ak-space-3)',
                  background: 'var(--ak-crimson-bg-muted)',
                  border: '1px solid var(--ak-border-red)',
                  borderRadius: 'var(--ak-radius-md)',
                }}>
                  <span className="ak-overline" style={{ color: 'var(--ak-gold)' }}>
                    {isMulti ? `The Mafioso · ${i + 1}/${mafiozos.length}` : 'The Mafioso'}
                  </span>
                  <p style={{ color: 'var(--ak-text-strong)', font: 'var(--ak-t-h3)', margin: 'var(--ak-space-2) 0 0' }}>
                    {m.username || '—'}
                    {m.characterName ? ` · ${m.characterName}` : ''}
                  </p>
                  {m.explanation && (
                    <p style={{ color: 'var(--ak-text-main)', marginTop: 'var(--ak-space-2)' }}>
                      {m.explanation}
                    </p>
                  )}
                </div>
              ))}
            </div>
          );
        })()}
      </section>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--ak-space-4)' }}>
        <Link to="/profile">
          <AkButton variant="ghost">عودة للملف الشخصي</AkButton>
        </Link>
      </div>
    </div>
  );
}
