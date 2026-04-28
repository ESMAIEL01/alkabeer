import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { socket, connectSocket, setActiveRoomId, clearActiveRoomId, emitWithAck } from '../services/socket';
import { api, getToken, getStoredUser, clearSession } from '../services/api';
import AkButton from '../components/AkButton';

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
    });

    socket.on('game_started', (data) => {
      const roomId = data?.id || activeRoom;
      if (roomId) {
        setActiveRoomId(roomId);
        navigate(`/game/${roomId}`);
      }
    });

    if (roomIdFromUrl && !activeRoom) {
      handleJoinRoom(roomIdFromUrl);
    }

    return () => {
      socket.off('room_update');
      socket.off('game_started');
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
      if (!activeRoom) { setError('الغرفة مش جاهزة لسه. دقيقة وحاول تاني.'); return; }
      setAiLoading(true);
      setError('');
      try {
        const data = await api.post('/api/scenarios/ai-generate', {
          idea: 'جريمة عشوائية مشوقة',
          players: players.length || 5,
          mood: 'مكس',
          difficulty: 'متوسط',
        });
        if (!data || !data.archive_b64 || !data.scenario) {
          throw new Error('الأرشيف رجع ناقص. حاول تاني.');
        }
        if (data.source === 'fallback' && data.note) {
          console.warn('[ai] fallback scenario:', data.note);
        }
        const ack = await emitWithAck('finalize_archive', {
          roomId: activeRoom,
          archive: data.archive_b64,
          raw: data.scenario,
          clues: data.clues,
        }, 8_000);
        if (!ack || !ack.success) throw new Error((ack && ack.error) || 'تعذّر ختم الأرشيف.');
        setActiveRoomId(ack.roomId || activeRoom);
        socket.emit('start_game_setup', { roomId: ack.roomId || activeRoom });
        navigate(`/game/${ack.roomId || activeRoom}`);
      } catch (err) {
        setError(err.message || 'فشل في الذكاء الاصطناعي');
      } finally {
        setAiLoading(false);
      }
    } else {
      if (!activeRoom) { setError('الغرفة مش جاهزة لسه.'); return; }
      setActiveRoomId(activeRoom);
      socket.emit('start_game_setup', { roomId: activeRoom });
      navigate('/host-dashboard');
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
          <AkButton variant="ghost" onClick={() => { clearSession(); navigate('/'); }}>انسحاب</AkButton>
        </div>
      </header>

      {!activeRoom ? (
        <>
          {error && <div className="s-auth-error">⚠ {error}</div>}

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
                  <h3 className="mode-title">عادي</h3>
                  <p className="mode-desc">كل لاعب يعرف شخصيته ودوره السري قبل بداية التحقيق.</p>
                </button>
                <button
                  type="button"
                  className="s-lobby-mode-card danger"
                  onClick={() => setRoleRevealMode('blind')}
                >
                  <h3 className="mode-title">عمياني</h3>
                  <p className="mode-desc">كل لاعب يعرف وظيفته وتفصيلته المريبة فقط. الحقيقة الكاملة بتظهر في الكشف النهائي.</p>
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
                  <h3 className="mode-title">مضيف بشري</h3>
                  <p className="mode-desc">إنت اللي بتكتب الأرشيف وبتدير الجلسة بصوتك.</p>
                </button>
                <button
                  type="button"
                  className="s-lobby-mode-card gold"
                  onClick={() => handleCreateRoom('AI')}
                >
                  <h3 className="mode-title">الكبير الاصطناعي</h3>
                  <p className="mode-desc">الذكاء بيكتب القصة، وإنت بتتحكم في الجلسة.</p>
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

            {(players.find(p => p.id === user.id)?.isHost) || (roomMode === 'AI' && creatorId === user.id) ? (
              <AkButton
                variant="primary"
                onClick={handleStartGame}
                disabled={aiLoading}
                style={{ width: '100%', padding: '1rem', fontSize: '1.05rem' }}
              >
                {aiLoading
                  ? 'الكبير يكتب الأرشيف...'
                  : roomMode === 'AI'
                  ? 'صناعة القصة بالذكاء وبدء اللعبة'
                  : 'انتقال لغرفة صياغة الأرشيف'}
              </AkButton>
            ) : (
              <div className="s-auth-error" style={{ background: 'rgba(212,175,55,0.08)', border: '1px solid var(--ak-border-gold)', color: 'var(--ak-gold)' }}>
                بانتظار الكبير لختم الأرشيف وبدء اللعبة...
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
