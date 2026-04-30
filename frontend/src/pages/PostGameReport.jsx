import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../services/api';
import AkButton from '../components/AkButton';

const OUTCOME_LABEL = {
  investigators_win: 'انتصر التحقيق',
  mafiozo_survives:  'المافيوزو نجى',
  aborted:           'انتهت الجلسة',
};

const OUTCOME_COLOR = {
  investigators_win: 'var(--ak-text-strong)',
  mafiozo_survives:  'var(--ak-crimson-action)',
  aborted:           'var(--ak-text-muted)',
};

const ROLE_LABEL = {
  mafiozo:         'المافيوزو',
  obvious_suspect: 'المشتبه الواضح',
  innocent:        'بريء',
};

function resolveMafiozos(finalReveal) {
  if (!finalReveal || !finalReveal.truth) return [];
  const { mafiozos, mafiozoUsername, mafiozoCharacterName, mafiozoExplanation } = finalReveal.truth;
  if (Array.isArray(mafiozos) && mafiozos.length > 0) return mafiozos;
  if (mafiozoUsername) return [{ username: mafiozoUsername, characterName: mafiozoCharacterName, explanation: mafiozoExplanation }];
  return [];
}

export default function PostGameReport() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const gameId    = location.state?.gameId ?? null;

  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(!!gameId);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get(`/api/archive/${encodeURIComponent(gameId)}`)
      .then(d  => { if (!cancelled) setData(d || null); })
      .catch(e => { if (!cancelled) setError((e && e.message) || 'تعذّر تحميل تقرير الجلسة.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [gameId]);

  /* ---- No gameId: reached without proper navigation ---- */
  if (!gameId) {
    return (
      <div className="s-report animate-fade-in">
        <section className="s-report-hero">
          <p className="ak-overline">Post-Game · تقرير الجلسة</p>
          <h1>لا يوجد تقرير نشط</h1>
          <p className="s-report-sub">
            تقرير الجلسة يظهر مباشرة بعد انتهاء اللعبة. ارجع للساحة وابدأ جلسة جديدة.
          </p>
          <div className="s-report-actions">
            <AkButton variant="primary" onClick={() => navigate('/lobby')}>ارجع للساحة</AkButton>
            <AkButton variant="ghost"   onClick={() => navigate('/profile')}>الملف الشخصي</AkButton>
          </div>
        </section>
      </div>
    );
  }

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className="s-report animate-fade-in">
        <section className="s-report-hero" style={{ textAlign: 'center' }}>
          <p className="ak-overline">Post-Game · تقرير الجلسة</p>
          <div className="ak-loading-dot pulse-animation" aria-hidden="true" />
          <p style={{ color: 'var(--ak-text-muted)' }}>الكبير بيحضّر التقرير...</p>
        </section>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error) {
    return (
      <div className="s-report animate-fade-in">
        <section className="s-report-hero">
          <p className="ak-overline">Post-Game · تقرير الجلسة</p>
          <h1>تعذّر تحميل التقرير</h1>
          <p className="s-report-sub">{error}</p>
          <div className="s-report-actions">
            <AkButton variant="primary" onClick={() => navigate('/lobby')}>ارجع للساحة</AkButton>
            <AkButton variant="ghost"   onClick={() => navigate('/profile')}>الملف الشخصي</AkButton>
          </div>
        </section>
      </div>
    );
  }

  /* ---- Real data ---- */
  const session     = (data && data.session)     || {};
  const caller      = (data && data.caller)      || {};
  const finalReveal = (data && data.finalReveal) || null;
  const outcome     = session.outcome || null;
  const mafiozos    = resolveMafiozos(finalReveal);

  const headlineTitle   = finalReveal?.headline?.title        || null;
  const closingLine     = finalReveal?.caseSummary?.closingLine || null;

  return (
    <div className="s-report animate-fade-in">

      {/* OUTCOME HERO */}
      <section className="s-report-hero">
        <p className="ak-overline">Post-Game · تقرير الجلسة</p>
        <h1 style={{ color: OUTCOME_COLOR[outcome] || 'var(--ak-text-strong)' }}>
          {OUTCOME_LABEL[outcome] || 'انتهت الجلسة'}
        </h1>
        {headlineTitle && (
          <p style={{ font: 'var(--ak-t-body-lg)', color: 'var(--ak-text-muted)', marginTop: 'var(--ak-space-2)', maxWidth: '50ch' }}>
            {headlineTitle}
          </p>
        )}
        {closingLine && (
          <p style={{ font: 'var(--ak-t-body)', color: 'var(--ak-gold)', fontStyle: 'italic', marginTop: 'var(--ak-space-3)', maxWidth: '50ch' }}>
            {closingLine}
          </p>
        )}
      </section>

      {/* MAFIOZO TRUTH */}
      {mafiozos.length > 0 && (
        <section className="s-report-section">
          <span className="ak-overline">Truth · الحقيقة</span>
          <h2 className="s-report-section-title">
            {mafiozos.length === 1 ? 'المافيوزو الحقيقي' : 'المافيوزو الحقيقيون'}
          </h2>
          {mafiozos.map((m, i) => (
            <div key={m.playerId || i} className="s-report-truth-row">
              <strong style={{ color: 'var(--ak-text-strong)', font: 'var(--ak-t-h4)' }}>
                {m.username || '—'}
                {m.characterName ? ` · ${m.characterName}` : ''}
              </strong>
              {m.explanation && (
                <p style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-body-sm)', marginTop: 'var(--ak-space-2)' }}>
                  {m.explanation}
                </p>
              )}
            </div>
          ))}
        </section>
      )}

      {/* CALLER RESULT */}
      {(caller.role || caller.wasWinner !== undefined) && (
        <section className="s-report-section">
          <span className="ak-overline">Your Result · نتيجتك</span>
          <h2 className="s-report-section-title">دورك في القضية</h2>
          <p style={{ font: 'var(--ak-t-body)', color: 'var(--ak-text-main)' }}>
            {caller.role && (
              <>
                <strong>الدور:</strong>
                {' '}
                <span style={{ color: 'var(--ak-gold)' }}>{ROLE_LABEL[caller.role] || caller.role}</span>
                {' · '}
              </>
            )}
            {caller.wasWinner === true  ? 'فايز'
            : caller.wasWinner === false ? 'خسران'
            : '—'}
          </p>
        </section>
      )}

      {/* ACTIONS */}
      <div className="s-report-actions">
        <AkButton variant="primary" onClick={() => navigate('/lobby')}>
          لعبة جديدة
        </AkButton>
        <AkButton variant="ghost" onClick={() => navigate(`/archive/${gameId}`)}>
          الأرشيف الكامل
        </AkButton>
        <AkButton variant="ghost" onClick={() => navigate('/profile')}>
          الملف الشخصي
        </AkButton>
      </div>

    </div>
  );
}
