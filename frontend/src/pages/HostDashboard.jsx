import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { emitWithAck, setActiveRoomId, getActiveRoomId } from '../services/socket';
import { api } from '../services/api';
import AkButton from '../components/AkButton';

// Cycling cinematic microcopy. Decorative — never claims real internals.
const AI_LOADING_LINES = [
  'الكبير بيقرأ الخيوط',
  'بيجمع الشبهات',
  'بيدبر الجريمة في دماغه',
  'الأرشيف بيتختم',
  'الساحة بتتجهز',
];

// Helper copy appears after the AI run feels slow. Encourages the host to
// switch to the deterministic premium case rather than waiting blindly.
const SLOW_HINT_AFTER_SEC = 13;

export default function HostDashboard() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [scenarioText, setScenarioText] = useState('');
  const [base64Archive, setBase64Archive] = useState('');
  const [clues, setClues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingPremium, setLoadingPremium] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const [error, setError] = useState('');
  const [showRawArchive, setShowRawArchive] = useState(false);
  const [sealing, setSealing] = useState('idle'); // idle | sealing | sealed
  const [loadingLineIdx, setLoadingLineIdx] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const loadingStartedAt = useRef(0);

  const isWorking = loading || loadingPremium || sealing === 'sealing';
  const isAiRunning = loading; // only the AI route shows the elapsed counter

  // Cycle the rotating microcopy.
  useEffect(() => {
    if (!isWorking) return;
    const id = setInterval(() => {
      setLoadingLineIdx(i => (i + 1) % AI_LOADING_LINES.length);
    }, 1700);
    return () => clearInterval(id);
  }, [isWorking]);

  // Track elapsed seconds for the AI run only; reset between runs.
  useEffect(() => {
    if (!isAiRunning) {
      setElapsedSec(0);
      return;
    }
    loadingStartedAt.current = Date.now();
    setElapsedSec(0);
    const id = setInterval(() => {
      const ms = Date.now() - loadingStartedAt.current;
      setElapsedSec(Math.max(0, Math.floor(ms / 1000)));
    }, 500);
    return () => clearInterval(id);
  }, [isAiRunning]);

  function readCustomCounters() {
    let cfg = null;
    try {
      const raw = sessionStorage.getItem('mafActiveRoomConfig');
      if (raw) cfg = JSON.parse(raw);
    } catch { cfg = null; }
    return (cfg && cfg.isCustom) ? {
      players: cfg.playerCount,
      clueCount: cfg.clueCount,
      mafiozoCount: cfg.mafiozoCount,
    } : { players: 5 };
  }

  function applyArchive(data) {
    setScenarioText(data.scenario || '');
    setBase64Archive(data.archive_b64 || '');
    setClues(Array.isArray(data.clues) ? data.clues : []);
    if (data.source === 'fallback' && data.note) setAiNote(data.note);
  }

  const handleGenerateAI = async () => {
    if (isWorking) return;
    setLoading(true);
    setError('');
    setAiNote('');
    const customCounters = readCustomCounters();
    try {
      const data = await api.post('/api/scenarios/ai-generate', {
        idea: prompt,
        ...customCounters,
        difficulty: 'متوسط',
      });
      applyArchive(data);
    } catch (err) {
      setError(err.message || 'فشل في توليد الأرشيف.');
    } finally {
      setLoading(false);
    }
  };

  const handleGeneratePremiumFallback = async () => {
    if (isWorking) return;
    setLoadingPremium(true);
    setError('');
    setAiNote('');
    const customCounters = readCustomCounters();
    try {
      const data = await api.post('/api/scenarios/premium-fallback', {
        idea: prompt,
        ...customCounters,
      });
      applyArchive(data);
      setAiNote('قضية جاهزة من مكتبة الكبير — اتختمت فورًا بدون انتظار.');
    } catch (err) {
      setError(err.message || 'تعذر تجهيز قضية جاهزة الآن.');
    } finally {
      setLoadingPremium(false);
    }
  };

  const finalizeScenario = async () => {
    if (sealing !== 'idle') return;
    setError('');
    if (!base64Archive || !scenarioText) {
      setError('لازم تولّد الأرشيف الأول.');
      return;
    }
    const roomId = getActiveRoomId();
    if (!roomId) {
      setError('الغرفة مش محفوظة. ارجع للساحة وابدأ غرفة جديدة.');
      return;
    }
    setSealing('sealing');
    try {
      const ack = await emitWithAck('finalize_archive', {
        roomId,
        archive: base64Archive,
        raw: scenarioText,
        clues,
      }, 8_000);
      if (!ack || !ack.success) throw new Error((ack && ack.error) || 'تعذّر ختم الأرشيف.');
      setActiveRoomId(ack.roomId || roomId);
      setSealing('sealed');
      setTimeout(() => navigate(`/game/${ack.roomId || roomId}`), 600);
    } catch (err) {
      setSealing('idle');
      const msg = err && err.message === 'socket-ack-timeout'
        ? 'الخادم ما ردّش في الوقت. تأكد من الاتصال وحاول تاني.'
        : (err.message || 'تعذّر ختم الأرشيف.');
      setError(msg);
    }
  };

  const sealLabel =
    sealing === 'sealing' ? AI_LOADING_LINES[loadingLineIdx] + '...'
    : sealing === 'sealed' ? 'تم الختم — جار فتح الساحة'
    : 'ختم الأرشيف وبدء اللعبة';

  const aiButtonLabel = loading
    ? AI_LOADING_LINES[loadingLineIdx] + '...'
    : 'توليد السيناريو بالذكاء الاصطناعي';
  const premiumButtonLabel = loadingPremium
    ? 'بيختار قضية جاهزة...'
    : 'ابدأ بقضية جاهزة عالية الجودة';

  return (
    <div className="s-host">
      {/* Hero — archive room mood */}
      <div className="s-host-hero">
        <span className="ov">Sealed Archive · Protocol Zero</span>
        <h1>غرفة <span className="glow">صياغة الأرشيف</span></h1>
        <p>اكتب فكرة الجريمة أو سيب الكبير يبدع. لما الأرشيف يتختم، الجلسة تبدأ.</p>
      </div>

      {/* Generation section */}
      <section className="s-host-section">
        <span className="section-label">01 · صناعة السيناريو</span>
        <h2 className="section-title">فكرة المضيف</h2>
        <textarea
          className="s-host-textarea"
          rows="3"
          placeholder="مثال: سرقة لوحة نادرة في متحف مصري… أو سيب الكبير يختار."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={isWorking || sealing !== 'idle'}
        />
        <div className="s-host-gen-actions">
          <AkButton
            variant="ghost"
            onClick={handleGenerateAI}
            disabled={isWorking || sealing !== 'idle'}
            style={{ width: '100%' }}
          >
            {aiButtonLabel}
          </AkButton>
          <AkButton
            variant="primary"
            onClick={handleGeneratePremiumFallback}
            disabled={isWorking || sealing !== 'idle'}
            style={{ width: '100%' }}
          >
            {premiumButtonLabel}
          </AkButton>
          <p className="s-host-gen-hint">
            القضية الجاهزة عالية الجودة بتختار من مكتبة الكبير الموثوقة وبتبدأ فورًا — مفيدة لو شبكتك بطيئة.
          </p>
        </div>
        {isWorking && (
          <div className="s-host-waiting" role="status" aria-live="polite">
            <div className="s-host-waiting-glow" aria-hidden="true" />
            <div className="s-host-waiting-line">
              {AI_LOADING_LINES[loadingLineIdx]}
              <span className="s-host-waiting-dots" aria-hidden="true">…</span>
            </div>
            {isAiRunning && (
              <div className="s-host-waiting-meta">
                <span className="s-host-waiting-elapsed">{elapsedSec}s</span>
                <span className="s-host-waiting-sep" aria-hidden="true">·</span>
                <span>الكبير لسه بيشتغل على القضية</span>
              </div>
            )}
            {isAiRunning && elapsedSec >= SLOW_HINT_AFTER_SEC && (
              <div className="s-host-waiting-hint">
                لو الانتظار طوّل عليك، تقدر تبدأ بقضية جاهزة عالية الجودة من مكتبة الكبير في ثانية.
              </div>
            )}
          </div>
        )}
        {error && (
          <div className="s-auth-error" style={{ marginTop: 'var(--ak-space-3)' }}>⚠ {error}</div>
        )}
        {aiNote && (
          <div className="s-host-ai-note">
            {aiNote}
          </div>
        )}
      </section>

      {/* Story + clues */}
      {scenarioText && (
        <section className="s-host-section animate-fade-in">
          <span className="section-label">02 · القصة الكاملة</span>
          <h2 className="section-title">القصة (سرية للمضيف)</h2>
          <div className="s-host-story-pre">{scenarioText}</div>

          {clues.length > 0 && (
            <>
              <span className="section-label" style={{ marginTop: 'var(--ak-space-4)' }}>الأدلة</span>
              <ol className="s-host-clue-list" style={{ paddingInlineStart: 0, listStyle: 'none' }}>
                {clues.map((c, i) => (
                  <li key={i}>
                    <span style={{ color: 'var(--ak-gold)', fontWeight: 700, marginInlineEnd: 'var(--ak-space-2)' }}>الدليل {i + 1}.</span>
                    {c}
                  </li>
                ))}
              </ol>
            </>
          )}

          <div style={{ marginTop: 'var(--ak-space-4)' }}>
            <AkButton
              variant="ghost"
              onClick={() => setShowRawArchive(s => !s)}
              style={{ padding: '0.5rem 0.85rem', minHeight: 'auto' }}
            >
              {showRawArchive ? 'إخفاء بيانات الأرشيف' : 'عرض بيانات الأرشيف (للمطورين)'}
            </AkButton>
            {showRawArchive && (
              <div style={{
                marginTop: 'var(--ak-space-3)',
                padding: 'var(--ak-space-3)',
                background: 'var(--ak-crimson-bg-muted)',
                border: '1px solid var(--ak-border-red)',
                borderRadius: 'var(--ak-radius-md)',
                font: 'var(--ak-t-mono)',
                fontSize: '0.78rem',
                color: 'var(--ak-text-on-danger)',
                wordBreak: 'break-all',
                direction: 'ltr',
                textAlign: 'left',
              }}>
                PROTOCOL_ZERO_HASH:<br />
                {base64Archive.slice(0, 200)}{base64Archive.length > 200 ? '…' : ''}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Seal action */}
      {scenarioText && (
        <div style={{ position: 'sticky', bottom: 0, padding: 'var(--ak-space-4) 0', background: 'linear-gradient(to top, var(--ak-bg-deep) 70%, transparent)' }}>
          <AkButton
            variant="primary"
            onClick={finalizeScenario}
            disabled={sealing !== 'idle'}
            style={{ width: '100%', padding: '1.1rem', fontSize: '1.1rem' }}
          >
            {sealLabel}
          </AkButton>
        </div>
      )}
    </div>
  );
}
