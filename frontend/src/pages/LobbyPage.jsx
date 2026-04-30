import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { socket, connectSocket, setActiveRoomId, clearActiveRoomId, emitWithAck } from '../services/socket';
import { api, getToken, getStoredUser, clearSession } from '../services/api';
import AkButton from '../components/AkButton';

/**
 * AiHostReadyPanel (FixPack v2 / Commit 3) — quorum panel for AI Host rooms.
 * Shows ready/total + custom-seat error + the per-player "Ready" toggle.
 * Visible to EVERY suspect player; no creator-only path.
 */
function AiHostReadyPanel({ progress, imReady, busy, onToggle, error, amISuspect, visibleSuspectCount }) {
  const required = (progress && Number.isFinite(progress.required)) ? progress.required : 3;
  const minSuspects = (progress && Number.isFinite(progress.minSuspects)) ? progress.minSuspects : 3;
  const ready = (progress && Number.isFinite(progress.ready)) ? progress.ready : 0;

  // FixPack v3 / Hotfix — derive an effective `total` so the panel never
  // says "الموجود: 0" when suspects are visibly present in the roster.
  // Backend total is preferred; if missing or smaller than the visible
  // suspect count (e.g. the very first ai_host_ready_progress hasn't
  // arrived yet on a freshly-joined client), fall back to the visible
  // count. The visibleSuspectCount prop is computed by LobbyPage from
  // its `players` state which arrives via the existing room_update.
  const backendTotal = (progress && Number.isFinite(progress.total)) ? progress.total : 0;
  const visibleTotal = Number.isFinite(visibleSuspectCount) ? visibleSuspectCount : 0;
  const total = Math.max(backendTotal, visibleTotal);

  // Same fallback for the "enoughSuspects" gate — if the backend hasn't
  // reported yet but the client can already see ≥ minSuspects players,
  // the start button should not be disabled spuriously.
  const enoughSuspects = (progress && progress.enoughSuspects) || total >= minSuspects;

  const customSeatGate = !progress || progress.customSeatGate !== false;
  const customSeatError = progress && progress.customSeatError;
  const inProgress = !!(progress && progress.inProgress) || busy;

  // Top status line.
  let statusLine;
  if (inProgress) {
    statusLine = 'الكبير بيبني الأرشيف...';
  } else if (!enoughSuspects) {
    statusLine = `لازم ${minSuspects} لاعبين على الأقل عشان تبدأ اللعبة. الموجود الآن: ${total}.`;
  } else if (!customSeatGate) {
    statusLine = customSeatError || 'الإعداد المخصص يحتاج عدد لاعبين بالضبط. لسه ناقص.';
  } else if (ready >= required) {
    statusLine = 'الكل جاهز. الكبير هيبدأ القضية حالاً.';
  } else if (ready > 0) {
    statusLine = `الجاهزون: ${ready} / ${required}. اضغط جاهز عشان تبدأ.`;
  } else {
    statusLine = 'اضغط جاهز، ولما 3 لاعبين يجهزوا الكبير هيبدأ القضية.';
  }

  // Secondary line — always shows BOTH counts so the user understands
  // the difference between "players present" and "players ready".
  const secondaryLine = (!inProgress && enoughSuspects && customSeatGate)
    ? `اللاعبون: ${total} • الجاهزون: ${ready} / ${required}`
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ak-space-3)' }}>
      <div
        style={{
          padding: 'var(--ak-space-3)',
          textAlign: 'center',
          color: 'var(--ak-gold)',
          background: 'rgba(212,175,55,0.08)',
          border: '1px solid var(--ak-border-gold)',
          borderRadius: 'var(--ak-radius-md, 6px)',
          font: 'var(--ak-t-body, inherit)',
          fontWeight: 600,
        }}
        aria-live="polite"
      >
        {statusLine}
        {secondaryLine && (
          <div style={{ marginTop: 'var(--ak-space-2)', font: 'var(--ak-t-caption, inherit)', color: 'var(--ak-text-muted)' }}>
            {secondaryLine}
          </div>
        )}
      </div>

      {amISuspect && !inProgress && (
        <AkButton
          variant={imReady ? 'ghost' : 'primary'}
          onClick={onToggle}
          disabled={busy || !enoughSuspects || !customSeatGate}
          style={{ width: '100%', padding: '1rem', fontSize: '1.05rem' }}
        >
          {imReady ? 'إلغاء الاستعداد' : 'جاهز لبدء اللعبة'}
        </AkButton>
      )}

      {amISuspect && imReady && !inProgress && (
        <div style={{ textAlign: 'center', font: 'var(--ak-t-caption, inherit)', color: 'var(--ak-text-muted)' }}>
          تم تسجيل جاهزيتك
        </div>
      )}

      {inProgress && (
        <div className="shimmer" style={{ height: '3rem' }} aria-hidden="true" />
      )}

      {error && (
        <div className="s-auth-error">{error}</div>
      )}
    </div>
  );
}

/**
 * LobbyPage — two-step setup (gameplay-mode → host-type) then the active-room
 * waiting view. Game logic and socket events are unchanged from prior commits;
 * only visual layout is redesigned to follow the Mafiozo Design System.
 */
export default function LobbyPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const roomIdFromUrl = searchParams.get('room');

  const [user, setUser] = useState(null);
  const [roomCode, setRoomCode] = useState(roomIdFromUrl || '');
  const [activeRoom, setActiveRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [error, setError] = useState('');
  const [roomMode, setRoomMode] = useState('HUMAN');
  const [roleRevealMode, setRoleRevealMode] = useState(null); // 'normal' | 'blind' | null
  const [creatorId, setCreatorId] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  // FixPack v2 / Commit 3: AI Host ready-quorum UI state.
  // Server broadcasts ai_host_ready_progress { ready, total, required,
  // minSuspects, customSeatGate, customSeatError, canStart, inProgress }.
  const [aiReadyProgress, setAiReadyProgress] = useState(null);
  const [imReadyForAi, setImReadyForAi] = useState(false);
  const [aiHostBusy, setAiHostBusy] = useState(false);
  const [aiHostError, setAiHostError] = useState('');

  // E4: Custom Mode toggles. Default 'افتراضي'; switching to 'مخصص' reveals
  // three number inputs. Config travels through create_room as
  // { config: {playerCount, mafiozoCount, clueCount, obviousSuspectEnabled} }
  // or null for default mode.
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [customPlayerCount, setCustomPlayerCount] = useState(5);
  const [customMafiozoCount, setCustomMafiozoCount] = useState(1);
  const [customClueCount, setCustomClueCount] = useState(3);
  const [activeRoomConfig, setActiveRoomConfig] = useState(null);

  // Clamp mafiozoCount whenever playerCount changes (max = floor((N-1)/2)).
  useEffect(() => {
    const maxM = Math.max(1, Math.floor((customPlayerCount - 1) / 2));
    if (customMafiozoCount > maxM) setCustomMafiozoCount(maxM);
  }, [customPlayerCount, customMafiozoCount]);

  const revealLabel = roleRevealMode === 'blind' ? 'عمياني' : roleRevealMode === 'normal' ? 'عادي' : '';
  const customMafiozoMax = Math.max(1, Math.floor((customPlayerCount - 1) / 2));

  useEffect(() => {
    const token = getToken();
    const u = getStoredUser();
    if (!token || !u) { navigate('/'); return; }
    setUser(u);
    connectSocket(token, u);
    clearActiveRoomId();

    socket.on('room_update', (data) => {
      setActiveRoom(data.id);
      setActiveRoomId(data.id);
      setPlayers(data.players);
      setRoomMode(data.mode);
      setCreatorId(data.creatorId);
      // FixPack v3 / Hotfix — embedded ai-host ready progress so the
      // panel reflects current suspects on the very first room_update,
      // before any ready/unready click. Falls through gracefully for
      // Human Host rooms (server sends null).
      if (data && Object.prototype.hasOwnProperty.call(data, 'aiHostReadyProgress')) {
        setAiReadyProgress(data.aiHostReadyProgress || null);
      }
    });

    socket.on('game_started', (data) => {
      const roomId = data?.id || activeRoom;
      if (roomId) {
        setActiveRoomId(roomId);
        navigate(`/game/${roomId}`);
      }
    });

    // FixPack v2 / Commit 3 — AI Host ready quorum events.
    socket.on('ai_host_ready_progress', (p) => {
      if (p && typeof p === 'object') setAiReadyProgress(p);
    });
    socket.on('ai_host_starting', () => {
      setAiHostBusy(true);
      setAiHostError('');
    });
    socket.on('ai_host_failed', (data) => {
      setAiHostBusy(false);
      setImReadyForAi(false);
      setAiHostError((data && data.error) || 'تعذّر بدء اللعبة. حاولوا تاني.');
    });

    if (roomIdFromUrl && !activeRoom) {
      handleJoinRoom(roomIdFromUrl);
    }

    return () => {
      socket.off('room_update');
      socket.off('game_started');
      socket.off('ai_host_ready_progress');
      socket.off('ai_host_starting');
      socket.off('ai_host_failed');
    };
  }, [navigate]);

  const handleCreateRoom = (mode = 'HUMAN') => {
    if (!roleRevealMode) {
      setError('اختار طور كشف الأدوار الأول.');
      return;
    }
    setError('');
    // E4: build the optional Custom Mode config payload.
    const config = isCustomMode ? {
      playerCount: customPlayerCount,
      mafiozoCount: customMafiozoCount,
      clueCount: customClueCount,
      obviousSuspectEnabled: true,
    } : null;
    socket.emit('create_room', { mode, roleRevealMode, config }, (response) => {
      if (response && response.success) {
        setActiveRoom(response.roomId);
        setActiveRoomId(response.roomId);
        setActiveRoomConfig(response.config || null);
        // Cache config in sessionStorage so HostDashboard can read it on
        // its own mount (separate page navigation drops React state).
        try {
          if (response.config) {
            sessionStorage.setItem('mafActiveRoomConfig', JSON.stringify(response.config));
          } else {
            sessionStorage.removeItem('mafActiveRoomConfig');
          }
        } catch { /* ignore quota / private-mode failures */ }
        window.history.replaceState(null, '', '/lobby');
      } else {
        setError((response && response.message) || 'فشل في إنشاء الغرفة السريّة.');
      }
    });
  };

  const handleJoinRoom = (code) => {
    const joinCode = code || roomCode;
    if (!joinCode) return;
    socket.emit('join_room', { roomId: joinCode }, (response) => {
      if (response && response.success) {
        setActiveRoom(response.roomId);
        setActiveRoomId(response.roomId);
      } else {
        setError((response && response.message) || 'الغرفة غير موجودة أو تم قفلها.');
      }
    });
  };

  const handleStartGame = async () => {
    if (roomMode === 'AI') {
      // FixPack v2 / Commit 3: AI Host rooms NEVER use a single creator
      // button. Use the ready-quorum flow instead. This branch is kept
      // only for the "بدء" legacy path.
      handleAiToggleReady();
      return;
    }
    if (!activeRoom) { setError('الغرفة مش جاهزة لسه.'); return; }
    setActiveRoomId(activeRoom);
    socket.emit('start_game_setup', { roomId: activeRoom });
    navigate('/host-dashboard');
  };

  // FixPack v2 / Commit 3 — toggle this player's "ready" signal in an
  // AI Host room. Server-side validates everything; we just send the
  // toggle and let the broadcast update aiReadyProgress.
  const handleAiToggleReady = () => {
    if (!activeRoom) return;
    if (aiHostBusy) return;
    setAiHostError('');
    if (imReadyForAi) {
      socket.emit('ai_host_unready', { roomId: activeRoom }, () => {
        setImReadyForAi(false);
      });
    } else {
      socket.emit('ai_host_ready', { roomId: activeRoom }, (resp) => {
        if (resp && resp.success) {
          setImReadyForAi(true);
        } else {
          setAiHostError((resp && resp.error) || 'تعذّر تسجيل استعدادك. حاول تاني.');
        }
      });
    }
  };

  if (!user) return <div className="container items-center justify-center cinematic-glow">يتم فك التشفير...</div>;

  const roomLink = `${window.location.origin}/lobby?room=${activeRoom}`;
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="s-lobby">
      {/* Header */}
      <header className="s-lobby-header">
        <div className="who">
          <span className="who-name">المحقق: {user.username}</span>
          {user.isGuest && <span className="who-tag">هوية مؤقتة (ضيف)</span>}
        </div>
        <div className="actions">
          <AkButton variant="ghost" onClick={() => navigate('/explain')}>القوانين</AkButton>
          {/* FixPack v2 / Commit 4: surface profile access from the lobby. */}
          <AkButton variant="ghost" onClick={() => navigate('/profile')}>ملفي الشخصي</AkButton>
          <AkButton variant="ghost" onClick={() => { clearSession(); navigate('/'); }}>انسحاب</AkButton>
        </div>
      </header>

      {!activeRoom ? (
        <>
          {error && <div className="s-auth-error">{error}</div>}

          {/* STEP 1: gameplay reveal mode */}
          {!roleRevealMode && (
            <section className="animate-fade-in">
              <div style={{ textAlign: 'center', marginBottom: 'var(--ak-space-4)' }}>
                <span className="s-lobby-step-label">Step 01</span>
                <div className="s-lobby-step-title">اختار طريقة كشف الأدوار</div>
              </div>
              <div className="s-lobby-mode-grid">
                <button
                  type="button"
                  className="s-lobby-mode-card gold"
                  onClick={() => setRoleRevealMode('normal')}
                >
                  <span className="mode-tag">STANDARD · كشف عادي</span>
                  <h3 className="mode-title">عادي</h3>
                  <p className="mode-desc">كل لاعب يعرف شخصيته ودوره السري قبل بداية التحقيق.</p>
                  <span className="mode-footer">مناسب للمبتدئين والمحترفين</span>
                </button>
                <button
                  type="button"
                  className="s-lobby-mode-card danger"
                  onClick={() => setRoleRevealMode('blind')}
                >
                  <span className="mode-tag">EXTREME · كشف أعمى</span>
                  <h3 className="mode-title">عمياني</h3>
                  <p className="mode-desc">كل لاعب يعرف وظيفته وتفصيلته المريبة فقط. الحقيقة الكاملة بتظهر في الكشف النهائي.</p>
                  <span className="mode-footer">مستوى متقدم</span>
                </button>
              </div>
            </section>
          )}

          {/* STEP 2: host type */}
          {roleRevealMode && (
            <section className="animate-fade-in">
              <div className={`s-lobby-mode-badge${roleRevealMode === 'blind' ? ' danger' : ''}`}>
                <div>
                  <div className="label">طور كشف الأدوار</div>
                  <div className="value">{revealLabel}</div>
                </div>
                <AkButton variant="ghost" onClick={() => setRoleRevealMode(null)}>تغيير الاختيار</AkButton>
              </div>

              {/* E4: Custom Mode toggle + inputs */}
              <div className="s-custom-block" style={{ marginBottom: 'var(--ak-space-4)' }}>
                <div className="s-custom-toggle">
                  <button
                    type="button"
                    className={`s-custom-toggle-btn${!isCustomMode ? ' active' : ''}`}
                    onClick={() => setIsCustomMode(false)}
                  >
                    افتراضي
                  </button>
                  <button
                    type="button"
                    className={`s-custom-toggle-btn${isCustomMode ? ' active' : ''}`}
                    onClick={() => setIsCustomMode(true)}
                  >
                    مخصص
                  </button>
                </div>
                {isCustomMode && (
                  <div className="s-custom-fields animate-fade-in">
                    <label className="s-custom-field">
                      <span>عدد اللاعبين</span>
                      <input
                        type="number"
                        min={3}
                        max={8}
                        value={customPlayerCount}
                        onChange={(e) => setCustomPlayerCount(Math.max(3, Math.min(8, parseInt(e.target.value, 10) || 3)))}
                      />
                      <small>عدد اللاعبين لا يشمل المضيف.</small>
                    </label>
                    <label className="s-custom-field">
                      <span>عدد المافيوزو</span>
                      <input
                        type="number"
                        min={1}
                        max={customMafiozoMax}
                        value={customMafiozoCount}
                        onChange={(e) => setCustomMafiozoCount(Math.max(1, Math.min(customMafiozoMax, parseInt(e.target.value, 10) || 1)))}
                      />
                      <small>الحد الأقصى: {customMafiozoMax}</small>
                    </label>
                    <label className="s-custom-field">
                      <span>عدد الأدلة</span>
                      <input
                        type="number"
                        min={1}
                        max={5}
                        value={customClueCount}
                        onChange={(e) => setCustomClueCount(Math.max(1, Math.min(5, parseInt(e.target.value, 10) || 3)))}
                      />
                      <small>عدد الأدلة = عدد جولات التصويت.</small>
                    </label>
                  </div>
                )}
              </div>

              <div style={{ textAlign: 'center', marginBottom: 'var(--ak-space-4)' }}>
                <span className="s-lobby-step-label">Step 02</span>
                <div className="s-lobby-step-title">اختار نوع المضيف</div>
              </div>

              <div className="s-lobby-mode-grid">
                <button
                  type="button"
                  className="s-lobby-mode-card gold"
                  onClick={() => handleCreateRoom('HUMAN')}
                >
                  <span className="mode-tag">HUMAN HOST · بشري</span>
                  <h3 className="mode-title">مضيف بشري</h3>
                  <p className="mode-desc">إنت اللي بتكتب الأرشيف وبتدير الجلسة بصوتك.</p>
                  <span className="mode-footer">تحكم كامل في القضية</span>
                </button>
                <button
                  type="button"
                  className="s-lobby-mode-card gold"
                  onClick={() => handleCreateRoom('AI')}
                >
                  <span className="mode-tag">AI HOST · ذكاء اصطناعي</span>
                  <h3 className="mode-title">الكبير الاصطناعي</h3>
                  <p className="mode-desc">الذكاء بيكتب القصة، وإنت بتتحكم في الجلسة.</p>
                  <span className="mode-footer">جاهز في ثوانٍ</span>
                </button>
              </div>
            </section>
          )}

          {/* Join existing */}
          <div className="divider"></div>
          <section style={{ textAlign: 'center' }}>
            <h3 className="s-lobby-step-label" style={{ marginBottom: 'var(--ak-space-3)' }}>أو ادخل غرفة قائمة</h3>
            <input
              type="text"
              placeholder="شفرة الغرفة"
              className="s-auth-field"
              style={{ textAlign: 'center', font: '700 1.5rem/1 var(--ak-font-mono)', letterSpacing: '8px', maxWidth: '320px', margin: '0 auto' }}
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
            />
            <div style={{ marginTop: 'var(--ak-space-3)' }}>
              <AkButton variant="ghost" onClick={() => handleJoinRoom()} disabled={!roomCode}>
                انضم للتحقيق
              </AkButton>
            </div>
          </section>
        </>
      ) : (
        <div className="s-lobby-room-shell">
          {/* Room access card */}
          <section className="ak-card ak-card-surface" style={{ textAlign: 'center' }}>
            <span className="s-lobby-step-label">Room Code</span>
            <div className="s-lobby-roomcode" style={{ margin: 'var(--ak-space-3) auto var(--ak-space-4)' }}>
              {String(activeRoom).split('').map((ch, i) => (
                <div key={i} className="ch">{ch}</div>
              ))}
            </div>
            {revealLabel && (
              <div style={{ marginBottom: 'var(--ak-space-2)' }}>
                <span style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-caption)' }}>طور: </span>
                <span style={{ color: roleRevealMode === 'blind' ? 'var(--ak-crimson-stage)' : 'var(--ak-gold)', fontWeight: 700 }}>{revealLabel}</span>
              </div>
            )}
            {activeRoomConfig && activeRoomConfig.isCustom && (
              <div style={{ marginBottom: 'var(--ak-space-4)' }}>
                <span className="s-custom-room-badge">
                  مخصص · {activeRoomConfig.playerCount} لاعبين · {activeRoomConfig.mafiozoCount} مافيوزو · {activeRoomConfig.clueCount} أدلة
                </span>
                <p style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-caption)', marginTop: 'var(--ak-space-2)' }}>
                  ابدأ الختم لما العدد يوصل {activeRoomConfig.playerCount} لاعبين.
                </p>
              </div>
            )}
            <p className="auth-sub">شارك الكود أو الرابط لدعوة اللاعبين</p>
            <div style={{ background: '#fff', padding: 'var(--ak-space-3)', borderRadius: 'var(--ak-radius-md)', display: 'inline-block', marginBottom: 'var(--ak-space-3)' }}>
              <QRCodeSVG value={roomLink} size={160} />
            </div>
            <input
              type="text"
              readOnly
              value={roomLink}
              className="s-auth-field"
              style={{ font: 'var(--ak-t-mono)', fontSize: '0.85rem', textAlign: 'center', direction: 'ltr' }}
              onClick={e => e.target.select()}
            />
          </section>

          {/* Players + start */}
          <section className="ak-card ak-card-surface">
            <span className="s-lobby-step-label">المشتبه بهم ({players.length})</span>
            <div className="s-lobby-roster" style={{ marginTop: 'var(--ak-space-3)', marginBottom: 'var(--ak-space-4)' }}>
              {players.length === 0 && <p className="auth-sub">لا يوجد أحد هنا بعد...</p>}
              {players.map(p => (
                <div key={p.id} className={`s-lobby-seat${p.isHost ? ' host' : ''}`}>
                  <div className="av">{initial(p.username)}</div>
                  <div>
                    <div className="nm">{p.username}{p.id === user.id ? ' (أنت)' : ''}</div>
                    <div className="tag">{p.isHost ? 'المضيف' : 'مشتبه'}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* FixPack v2 / Commit 3 — AI Host rooms use a ready-quorum panel
                visible to EVERY suspect player. No single-creator button. */}
            {roomMode === 'AI' ? (
              <AiHostReadyPanel
                progress={aiReadyProgress}
                imReady={imReadyForAi}
                busy={aiHostBusy}
                onToggle={handleAiToggleReady}
                error={aiHostError}
                amISuspect={!!players.find(p => p.id === user.id)}
                /* FixPack v3 / Hotfix — count of real non-host suspects
                   visible in the roster. Used as a fallback for the
                   panel's `total` so the UI never says "الموجود: 0"
                   when players are clearly present. */
                visibleSuspectCount={players.filter(p => p && p.id && p.username && !p.isHost).length}
              />
            ) : (players.find(p => p.id === user.id)?.isHost) ? (
              <AkButton
                variant="primary"
                onClick={handleStartGame}
                disabled={aiLoading}
                style={{ width: '100%', padding: '1rem', fontSize: '1.05rem' }}
              >
                {aiLoading ? 'يتم التجهيز...' : 'انتقال لغرفة صياغة الأرشيف'}
              </AkButton>
            ) : (
              <div className="s-auth-error" style={{ background: 'rgba(212,175,55,0.08)', border: '1px solid var(--ak-border-gold)', color: 'var(--ak-gold)' }}>
                بانتظار المضيف لختم الأرشيف وبدء اللعبة...
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
