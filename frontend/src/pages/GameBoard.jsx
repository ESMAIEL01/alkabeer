import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { socket, setActiveRoomId, getActiveRoomId } from '../services/socket';
import { getStoredUser } from '../services/api';

/**
 * GameBoard — the live arena. Survives:
 *   - direct navigation (/game/:roomId from a deep link)
 *   - tab refresh (re-requests private role card)
 *   - brief socket disconnects
 *
 * Phases handled:
 *   LOADING | NOT_FOUND | LOBBY | ROLE_REVEAL | PUBLIC_CHARACTER_OVERVIEW |
 *   ARCHIVE_LOCKED (legacy) | CLUE_REVEAL | VOTING | POST_GAME
 *
 * Privacy: roleCard state holds the LOCAL player's private card only.
 * Other players' roles never reach this client.
 */
export default function GameBoard() {
  const { roomId: routeRoomId } = useParams();
  const navigate = useNavigate();

  const roomId = routeRoomId || getActiveRoomId();

  const [gameState, setGameState] = useState('LOADING');
  const [timer, setTimer] = useState(0);
  const [archiveBase64, setArchiveBase64] = useState('');
  const [currentClue, setCurrentClue] = useState('');
  const [players, setPlayers] = useState([]);
  const [publicCards, setPublicCards] = useState([]);
  const [roleRevealMode, setRoleRevealMode] = useState('normal');
  const [roleCard, setRoleCard] = useState(null);  // LOCAL player's private card
  const [amIHost, setAmIHost] = useState(false);
  const [myVote, setMyVote] = useState(null);
  const [user] = useState(getStoredUser());
  const stateReceivedRef = useRef(false);
  const [votingProgress, setVotingProgress] = useState({ voted: 0, total: 0 });
  const [voteResult, setVoteResult] = useState(null);
  const [voteError, setVoteError] = useState('');
  const [eliminatedIds, setEliminatedIds] = useState([]);
  const [outcome, setOutcome] = useState(null);
  const [clueIndex, setClueIndex] = useState(0);
  const [totalClues, setTotalClues] = useState(3);
  const [hostError, setHostError] = useState('');     // Arabic error from rejected host action
  const [sessionEnded, setSessionEnded] = useState(false);

  // Reset per-round transient state when we enter a new VOTING round.
  useEffect(() => {
    if (gameState === 'VOTING') {
      setMyVote(null);
      setVoteError('');
      setVoteResult(null);
    }
  }, [gameState]);

  useEffect(() => {
    if (!roomId) {
      setGameState('NOT_FOUND');
      return;
    }
    setActiveRoomId(roomId);

    socket.emit('join_room', { roomId }, (resp) => {
      if (resp && resp.success === false && !stateReceivedRef.current) {
        setGameState('NOT_FOUND');
      }
    });
    socket.emit('get_game_state', { roomId });
    // Best-effort: ask the server to resend our private role card so a tab
    // refresh during ROLE_REVEAL or after still gets the card we missed.
    socket.emit('request_role_card', { roomId });

    const onFullState = (data) => {
      stateReceivedRef.current = true;
      setPlayers(data.players || []);
      setPublicCards(Array.isArray(data.publicCharacterCards) ? data.publicCharacterCards : []);
      if (data.roleRevealMode) setRoleRevealMode(data.roleRevealMode);
      if (data.phase) setGameState(data.phase);
      setTimer(data.timer ?? 0);
      if (data.archive) setArchiveBase64(data.archive);
      if (data.currentClue) setCurrentClue(data.currentClue);
      if (typeof data.clueIndex === 'number') setClueIndex(data.clueIndex);
      if (typeof data.totalClues === 'number' && data.totalClues > 0) setTotalClues(data.totalClues);
      if (Array.isArray(data.eliminatedIds)) setEliminatedIds(data.eliminatedIds);
      if (data.lastVoteResult) setVoteResult(data.lastVoteResult);
      if (data.outcome !== undefined) setOutcome(data.outcome);
      setAmIHost(data.hostId === user?.id);
    };
    const onTimer = (time) => setTimer(time);
    const onPhaseChange = (newPhase) => setGameState(newPhase);
    const onArchiveSealed = (data) => setArchiveBase64(data?.archive || '');
    const onClueRevealed = (data) => setCurrentClue(data?.text || '');
    const onVoteRegistered = (data) => {
      if (data && data.userId === user?.id) setMyVote(data.targetId);
    };
    const onVoteRejected = (data) => {
      setVoteError((data && data.message) || 'تعذّر تسجيل الصوت.');
      // Auto-clear after a few seconds so the next attempt isn't shadowed.
      setTimeout(() => setVoteError(''), 3500);
    };
    const onVotingProgress = (data) => {
      if (data && typeof data.voted === 'number' && typeof data.total === 'number') {
        setVotingProgress(data);
      }
    };
    const onVoteResult = (data) => setVoteResult(data || null);
    const onYourRoleCard = (card) => setRoleCard(card || null);
    const onHostActionRejected = (data) => {
      setHostError((data && data.message) || 'العملية رفضت.');
      setTimeout(() => setHostError(''), 3500);
    };
    const onSessionEnded = () => setSessionEnded(true);

    socket.on('full_state_update', onFullState);
    socket.on('timer_update', onTimer);
    socket.on('phase_change', onPhaseChange);
    socket.on('archive_sealed', onArchiveSealed);
    socket.on('clue_revealed', onClueRevealed);
    socket.on('vote_registered', onVoteRegistered);
    socket.on('vote_rejected', onVoteRejected);
    socket.on('voting_progress', onVotingProgress);
    socket.on('vote_result', onVoteResult);
    socket.on('your_role_card', onYourRoleCard);
    socket.on('host_action_rejected', onHostActionRejected);
    socket.on('session_ended', onSessionEnded);

    const recoveryTimer = setTimeout(() => {
      if (!stateReceivedRef.current) setGameState('NOT_FOUND');
    }, 12_000);

    return () => {
      clearTimeout(recoveryTimer);
      socket.off('full_state_update', onFullState);
      socket.off('timer_update', onTimer);
      socket.off('phase_change', onPhaseChange);
      socket.off('archive_sealed', onArchiveSealed);
      socket.off('clue_revealed', onClueRevealed);
      socket.off('vote_registered', onVoteRegistered);
      socket.off('vote_rejected', onVoteRejected);
      socket.off('voting_progress', onVotingProgress);
      socket.off('vote_result', onVoteResult);
      socket.off('your_role_card', onYourRoleCard);
      socket.off('host_action_rejected', onHostActionRejected);
      socket.off('session_ended', onSessionEnded);
    };
  }, [roomId, user?.id]);

  // Named host action — server may ack with `{ success: false, error: '<arabic>' }`.
  const handleHostAction = (action) => {
    setHostError('');
    socket.emit('host_control', { action, roomId }, (resp) => {
      if (resp && resp.success === false && resp.error) {
        setHostError(resp.error);
        setTimeout(() => setHostError(''), 3500);
      }
    });
  };
  const confirmEndSession = () => {
    if (window.confirm('متأكد إنك عايز تنهي الجلسة دلوقتي؟')) {
      handleHostAction('end_session');
    }
  };
  const handleVote = (targetId) => socket.emit('submit_vote', { roomId, targetId });

  // ----- recovery / loading ----------------------------------------------
  if (sessionEnded) {
    return (
      <div className="container animate-fade-in" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div className="card text-center max-w-md mx-auto" style={{ padding: '2.5rem' }}>
          <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🚪</div>
          <h2 className="cinematic-glow mb-3">المضيف أنهى الجلسة</h2>
          <p className="text-muted mb-6">يلا نبدأ غرفة جديدة؟</p>
          <button className="btn-primary" onClick={() => navigate('/lobby')}>ارجع للساحة</button>
        </div>
      </div>
    );
  }

  if (gameState === 'NOT_FOUND') {
    return (
      <div className="container animate-fade-in" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div className="card text-center max-w-md mx-auto" style={{ padding: '2.5rem' }}>
          <div style={{ fontSize: '4rem', marginBottom: '1rem', filter: 'drop-shadow(0 0 20px rgba(229,9,20,0.4))' }}>🚪</div>
          <h2 className="cinematic-glow mb-4">تعذر استعادة الغرفة</h2>
          <p className="text-muted mb-6">الغرفة انتهت أو غير موجودة. ارجع للساحة وابدأ غرفة جديدة.</p>
          <button className="btn-primary" onClick={() => navigate('/lobby')}>ارجع للساحة</button>
        </div>
      </div>
    );
  }
  if (gameState === 'LOADING') {
    return (
      <div className="container animate-fade-in" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div className="card text-center max-w-md mx-auto" style={{ padding: '2.5rem' }}>
          <div className="pulse-animation" style={{ fontSize: '5rem', marginBottom: '1rem', filter: 'drop-shadow(0 0 25px rgba(229,9,20,0.6))' }}>🔴</div>
          <h2 className="cinematic-glow mb-2">جاري استعادة حالة اللعبة...</h2>
          <p className="text-muted">الكبير بيفتح الأرشيف، استنى لحظة.</p>
          {roomId && (
            <p className="golden-text mt-4" style={{ fontSize: '0.9rem', letterSpacing: '2px' }}>
              غرفة: {roomId}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ----- ROLE_REVEAL: each player sees their own private card -------------
  if (gameState === 'ROLE_REVEAL') {
    const isBlind = roleRevealMode === 'blind' || roleCard?.mode === 'blind';
    return (
      <div className="container mt-2 animate-fade-in" style={{ maxWidth: '720px' }}>
        <div className="flex justify-between items-center mb-4 p-3 rounded-xl" style={{ background: 'rgba(0,0,0,0.6)', borderBottom: '1px solid var(--accent-gold)' }}>
          <h3 className="golden-text" style={{ margin: 0, fontSize: '1.2rem' }}>هويتك في التحقيق</h3>
          <div className="text-muted" style={{ fontSize: '1rem', fontFamily: 'monospace' }}>
            ⏳ 00:{Math.max(0, timer).toString().padStart(2, '0')}
          </div>
        </div>

        {amIHost ? (
          // ---- Host view: overview, never sees other players' game roles --
          <div className="card p-4 animate-fade-in">
            <h2 className="cinematic-glow mb-2 text-center">تم توزيع الشخصيات</h2>
            <p className="text-muted text-center mb-4">اقرأ الجدول وراقب اللعبة. ممنوع تكشف الأدوار الخفية.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.75rem' }}>
              {publicCards.map(c => (
                <div key={c.playerId} className="card" style={{ padding: '0.9rem', background: 'rgba(0,0,0,0.4)' }}>
                  <div className="golden-text" style={{ fontSize: '1rem', fontWeight: 700 }}>{c.username}</div>
                  <div style={{ fontSize: '0.95rem', marginTop: '0.25rem' }}>
                    🎭 {c.storyCharacterName} <span className="text-muted">— {c.storyCharacterRole}</span>
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.8rem', marginTop: '0.4rem', fontStyle: 'italic' }}>
                    !!{c.suspiciousDetail}!!
                  </div>
                </div>
              ))}
            </div>
            <p className="text-muted text-center mt-4" style={{ fontSize: '0.85rem' }}>
              المرحلة الجاية: عرض عام للشخصيات على كل اللاعبين، وبعدها أول دليل.
            </p>
            <div className="flex justify-center gap-3 mt-4" style={{ flexWrap: 'wrap' }}>
              <button className="btn-primary" onClick={() => handleHostAction('start_first_clue')} style={{ width: 'auto', flex: '1 1 200px' }}>
                ابدأ الجولة الأولى ⏭️
              </button>
              <button className="btn-secondary" onClick={confirmEndSession} style={{ width: 'auto', flex: '0 1 140px' }}>
                إنهاء الجلسة
              </button>
            </div>
            {hostError && (
              <div className="mt-3 p-2 rounded text-center" style={{ background: 'rgba(229,9,20,0.18)', border: '1px solid var(--accent-red)' }}>⚠️ {hostError}</div>
            )}
          </div>
        ) : !roleCard ? (
          // ---- Player view, card not yet received -----------------------
          <div className="card text-center p-6 animate-fade-in">
            <div className="pulse-animation" style={{ fontSize: '3.5rem' }}>🎴</div>
            <h2 className="cinematic-glow mt-2">الكبير بيوزع البطاقات...</h2>
            <p className="text-muted mt-2">استنى لحظة.</p>
          </div>
        ) : (
          // ---- Player view, private card --------------------------------
          <div className="card p-5 animate-fade-in role-card">
            {/* Story-character banner */}
            <div className="text-center mb-4">
              <p className="text-muted" style={{ fontSize: '0.85rem', letterSpacing: '2px' }}>أنت تلعب بشخصية</p>
              <h1 className="golden-text" style={{ fontSize: '2.4rem', margin: '0.25rem 0 0.4rem' }}>
                {roleCard.storyCharacterName}
              </h1>
              <p className="text-main" style={{ fontSize: '1rem' }}>{roleCard.storyCharacterRole}</p>
            </div>

            {/* Suspicious detail */}
            <div className="mb-4 p-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-muted mb-1" style={{ fontSize: '0.8rem', letterSpacing: '1.5px' }}>التفصيلة المريبة</div>
              <p style={{ margin: 0, fontStyle: 'italic', fontSize: '1rem' }}>!!{roleCard.suspiciousDetail}!!</p>
            </div>

            {/* Hidden role — NORMAL MODE ONLY */}
            {!isBlind && roleCard.gameRole && (
              <div className="mb-4 p-3 rounded-lg cinematic-glow" style={{
                background: roleCard.gameRole === 'mafiozo' ? 'rgba(229,9,20,0.15)' : roleCard.gameRole === 'obvious_suspect' ? 'rgba(212,175,55,0.12)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${roleCard.gameRole === 'mafiozo' ? 'var(--accent-red)' : 'var(--accent-gold)'}`,
              }}>
                <div className="text-muted mb-1" style={{ fontSize: '0.8rem', letterSpacing: '1.5px' }}>هويتك السرية</div>
                <p style={{ margin: 0, fontSize: '1.4rem', fontWeight: 800 }}>
                  {roleCard.roleLabelArabic}
                </p>
                <p style={{ margin: '0.5rem 0 0', fontSize: '0.95rem' }}>{roleCard.objective}</p>
              </div>
            )}

            {/* Blind-mode notice */}
            {isBlind && (
              <div className="mb-4 p-3 rounded-lg" style={{ background: 'rgba(229,9,20,0.1)', border: '1px solid rgba(229,9,20,0.4)' }}>
                <p className="cinematic-glow mb-1" style={{ margin: 0, fontSize: '1.05rem' }}>طور عمياني</p>
                <p className="text-muted" style={{ margin: 0, fontSize: '0.9rem' }}>
                  أنت تعرف وظيفتك وتفصيلتك المريبة فقط. الحقيقة الكاملة هتظهر في النهاية.
                </p>
                {roleCard.objective && (
                  <p style={{ margin: '0.4rem 0 0', fontSize: '0.95rem' }}>{roleCard.objective}</p>
                )}
              </div>
            )}

            <p className="text-muted text-center" style={{ fontSize: '0.8rem' }}>⚠️ {roleCard.warning || 'ممنوع تكشف بطاقتك للاعبين التانيين.'}</p>
          </div>
        )}
      </div>
    );
  }

  // ----- PUBLIC_CHARACTER_OVERVIEW: 10 s public summary -------------------
  if (gameState === 'PUBLIC_CHARACTER_OVERVIEW') {
    return (
      <div className="container mt-2 animate-fade-in" style={{ maxWidth: '1100px' }}>
        <div className="text-center mb-4">
          <h2 className="cinematic-glow" style={{ fontSize: '2.2rem' }}>الشخصيات على الطاولة</h2>
          <p className="text-muted mt-1">قدامكم {timer} ثواني تحفظوا مين مين، وبعدها التحقيق يبدأ.</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem' }}>
          {publicCards.map(c => (
            <div key={c.playerId} className="card animate-fade-in" style={{ padding: '1rem' }}>
              <div className="golden-text" style={{ fontSize: '1.1rem', fontWeight: 700 }}>{c.username}</div>
              <div style={{ fontSize: '1rem', marginTop: '0.4rem' }}>
                🎭 {c.storyCharacterName}
                <span className="text-muted"> — {c.storyCharacterRole}</span>
              </div>
              <div className="text-muted" style={{ fontSize: '0.85rem', marginTop: '0.6rem', fontStyle: 'italic' }}>
                !!{c.suspiciousDetail}!!
              </div>
            </div>
          ))}
        </div>
        {amIHost && (
          <div className="text-center mt-5">
            <button className="btn-primary" onClick={() => handleHostAction('skip_public_overview')} style={{ maxWidth: '320px', margin: '0 auto' }}>
              ابدأ الدليل الأول دلوقتي ⏭️
            </button>
            {hostError && (
              <div className="mt-3 p-2 rounded mx-auto" style={{ background: 'rgba(229,9,20,0.18)', border: '1px solid var(--accent-red)', maxWidth: '420px' }}>⚠️ {hostError}</div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ----- main arena (CLUE_REVEAL / VOTING / POST_GAME / legacy ARCHIVE_LOCKED)
  return (
    <div className="container mt-2 animate-fade-in" style={{ maxWidth: '1400px' }}>
      <div className="flex justify-between items-center mb-6 p-4 rounded-xl" style={{ background: 'rgba(0,0,0,0.6)', borderBottom: '2px solid var(--accent-red)' }}>
        <h2 className="golden-text" style={{ margin: 0 }}>الساحة المستديرة ⚖️</h2>
        <div style={{
          fontSize: '2rem', fontWeight: '900',
          color: timer <= 10 ? 'var(--accent-red)' : 'var(--text-main)',
          fontFamily: 'monospace',
        }} className={timer <= 10 && timer > 0 ? 'pulse-animation' : ''}>
          ⏳ 00:{Math.max(0, timer).toString().padStart(2, '0')}
        </div>
      </div>

      <div className="flex flex-wrap gap-6" style={{ minHeight: '65vh' }}>
        <div className="card flex-col justify-center items-center" style={{ flex: '1 1 60%', position: 'relative' }}>

          {gameState === 'LOBBY' && (
            <div className="text-center">
              <h2 className="cinematic-glow">جاري تهيئة التحقيق...</h2>
              <p className="text-muted mt-2">في انتظار باقي اللاعبين</p>
            </div>
          )}

          {gameState === 'ARCHIVE_LOCKED' && (
            <div className="animate-fade-in text-center w-full max-w-lg mx-auto">
              <div className="mb-6 pulse-animation" style={{ fontSize: '5rem', filter: 'drop-shadow(0 0 20px rgba(229,9,20,0.6))' }}>🔒</div>
              <h2 className="cinematic-glow mb-4" style={{ fontSize: '2.5rem' }}>الأرشيف مختوم</h2>
              <p className="text-muted mb-6">تم تشفير الحقيقة. القصة ثابتة ولا مجال لتغييرها الآن.</p>
              <div className="p-4 rounded-lg mb-6" style={{ backgroundColor: 'rgba(20, 0, 0, 0.5)', border: '1px solid var(--accent-red)', color: 'rgba(255,255,255,0.5)', wordBreak: 'break-all', fontSize: '0.8rem' }}>
                PROTOCOL_ZERO_HASH:<br />{archiveBase64.slice(0, 200)}{archiveBase64.length > 200 ? '…' : ''}
              </div>
              <p className="golden-text pulse-animation">بانتظار نطق الدليل...</p>
            </div>
          )}

          {gameState === 'CLUE_REVEAL' && (
            <div className="animate-fade-in text-center w-full">
              <h3 className="golden-text mb-6" style={{ fontSize: '2.2rem' }}>🔍 دليل من الكبير</h3>
              <div className="cinematic-glow p-6 rounded-xl mx-auto" style={{ fontSize: '1.6rem', backgroundColor: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.1)', maxWidth: '80%' }}>
                "{currentClue || 'لا يوجد دليل متاح حالياً.'}"
              </div>
              <p className="mt-8 text-muted">تناقشوا فيما بينكم. الوقت يمر.</p>
            </div>
          )}

          {gameState === 'VOTING' && (() => {
            const me = players.find(p => p.id === user?.id);
            const iAmEliminated = me ? !me.isAlive : false;
            const canVote = !amIHost && !iAmEliminated;
            const aliveNonHost = players.filter(p => !p.isHost && p.isAlive);
            return (
              <div className="animate-fade-in text-center w-full">
                <div className="mb-3 pulse-animation" style={{ fontSize: '3.5rem' }}>⚠️</div>
                <h1 className="cinematic-glow mb-2" style={{ fontSize: '2.6rem' }}>حان وقت الحُكم</h1>
                <p className="text-muted mb-2" style={{ fontSize: '1.05rem' }}>
                  جولة {Math.min(clueIndex + 1, totalClues)} من {totalClues} — مين المشتبه فيه النوبة دي؟
                </p>
                <p className="golden-text mb-6" style={{ fontSize: '1rem' }}>
                  صوّت {votingProgress.voted} من {votingProgress.total}
                </p>

                {voteError && (
                  <div className="mb-4 mx-auto p-2 rounded text-main" style={{ background: 'rgba(229,9,20,0.18)', border: '1px solid var(--accent-red)', maxWidth: '480px' }}>
                    ⚠️ {voteError}
                  </div>
                )}

                {amIHost && (
                  <div className="mb-4 mx-auto p-3 rounded text-muted" style={{ background: 'rgba(0,0,0,0.5)', border: '1px dashed var(--border-subtle)', maxWidth: '480px' }}>
                    🎩 المضيف لا يصوّت. تابع تقدّم اللاعبين.
                  </div>
                )}
                {iAmEliminated && (
                  <div className="mb-4 mx-auto p-3 rounded text-muted" style={{ background: 'rgba(229,9,20,0.1)', border: '1px solid rgba(229,9,20,0.3)', maxWidth: '480px' }}>
                    💀 خرجت من التحقيق، مش هتقدر تصوّت في الجولة دي.
                  </div>
                )}

                <div className="flex justify-center flex-wrap gap-4 mx-auto" style={{ maxWidth: '80%' }}>
                  {aliveNonHost.map(p => (
                    <button
                      key={p.id}
                      className="btn-secondary"
                      disabled={!canVote || p.id === user?.id /* can vote self if rules allow; keep enabled */}
                      style={{
                        width: '45%',
                        fontSize: '1.2rem',
                        padding: '1.5rem',
                        background: myVote === p.id ? 'var(--accent-red)' : '',
                        opacity: canVote ? 1 : 0.55,
                        cursor: canVote ? 'pointer' : 'not-allowed',
                      }}
                      onClick={() => canVote && handleVote(p.id)}
                    >
                      {p.username} {myVote === p.id && '✅'}
                    </button>
                  ))}
                  <button
                    className="btn-secondary"
                    disabled={!canVote}
                    style={{
                      width: '45%',
                      fontSize: '1.2rem',
                      padding: '1.5rem',
                      background: myVote === 'skip' ? '#555' : '',
                      opacity: canVote ? 1 : 0.55,
                      cursor: canVote ? 'pointer' : 'not-allowed',
                    }}
                    onClick={() => canVote && handleVote('skip')}
                  >
                    امتناع عن التصويت {myVote === 'skip' && '✅'}
                  </button>
                </div>
              </div>
            );
          })()}

          {gameState === 'VOTE_RESULT' && voteResult && (() => {
            const elim = voteResult.eliminatedUsername;
            const titleText =
              voteResult.reason === 'majority'
                ? (voteResult.wasMafiozo ? 'اتقبض على المافيوزو!' : `${elim} خرج من اللعبة`)
                : voteResult.reason === 'tie'
                ? 'تعادل في التصويت — محدش خرج'
                : voteResult.reason === 'no-vote'
                ? 'محدش صوّت — الجولة عدّت'
                : voteResult.reason === 'all-skip'
                ? 'الكل امتنع عن التصويت'
                : '...';
            const subText =
              voteResult.reason === 'majority'
                ? (voteResult.wasMafiozo
                    ? 'الأرشيف هيتفك دلوقتي. الحقيقة كلها جاية.'
                    : 'الجولة الجاية هتبدأ بدليل جديد.')
                : 'الجولة الجاية هتبدأ بدليل جديد.';
            const accent = voteResult.reason === 'majority' && voteResult.wasMafiozo
              ? 'var(--accent-gold)'
              : voteResult.reason === 'majority'
                ? 'var(--accent-red)'
                : 'var(--text-muted)';
            return (
              <div className="animate-fade-in text-center w-full">
                <div className="mb-3" style={{ fontSize: '4rem', filter: `drop-shadow(0 0 22px ${accent})` }}>
                  {voteResult.wasMafiozo ? '🎯' : voteResult.eliminatedUsername ? '⚖️' : '🤐'}
                </div>
                <h1 className="cinematic-glow mb-3" style={{ fontSize: '2.4rem', color: accent }}>{titleText}</h1>
                <p className="text-muted mb-4" style={{ fontSize: '1.05rem' }}>{subText}</p>
                <div className="mx-auto p-3 rounded-lg" style={{
                  background: 'rgba(0,0,0,0.45)',
                  border: '1px solid var(--border-subtle)',
                  maxWidth: '520px',
                  textAlign: 'right',
                }}>
                  <div className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                    صوّت {voteResult.votedCount} من {voteResult.eligibleCount} — جولة {voteResult.round} من {totalClues}
                  </div>
                  {voteResult.tally && Object.keys(voteResult.tally).length > 0 && (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                      {Object.entries(voteResult.tally)
                        .sort((a, b) => b[1] - a[1])
                        .map(([targetId, count]) => {
                          const targetPlayer = players.find(p => String(p.id) === String(targetId));
                          const label = targetId === 'skip' ? 'امتناع' : (targetPlayer?.username || targetId);
                          return (
                            <li key={targetId} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.25rem 0' }}>
                              <span>{label}</span>
                              <span className="golden-text">{count} صوت</span>
                            </li>
                          );
                        })}
                    </ul>
                  )}
                </div>
              </div>
            );
          })()}

          {(gameState === 'POST_GAME' || gameState === 'FINAL_REVEAL') && (
            <div className="animate-fade-in text-center w-full">
              {/* Commit 4 will replace this with the cinematic crime reconstruction. */}
              <h1 className="cinematic-glow mb-3" style={{ fontSize: '2.5rem' }}>
                {outcome === 'investigators_win'
                  ? 'انتصر التحقيق!'
                  : outcome === 'mafiozo_survives'
                  ? 'المافيوزو نجا...'
                  : 'انتهت التحقيقات'}
              </h1>
              <p className="text-muted mb-6">{
                outcome === 'investigators_win'
                  ? 'القبض على المافيوزو قبل ما يكمل خطته. المحققين كسبوا.'
                  : outcome === 'mafiozo_survives'
                  ? 'الأرشيف اتفك. الحقيقة هتظهر بعد ثواني.'
                  : 'انتهت الجلسة.'
              }</p>
              <button className="btn-primary" onClick={() => navigate('/lobby')} style={{ maxWidth: '300px', margin: '0 auto' }}>
                ارجع للساحة
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-6" style={{ flex: '1 1 30%', minWidth: '350px' }}>
          {amIHost && (
            <div className="card p-4" style={{ background: 'rgba(20, 0, 0, 0.4)', border: '1px solid rgba(229, 9, 20, 0.3)' }}>
              <h4 className="golden-text mb-3"><span>🕹️</span> لوحة تحكم الكبير</h4>

              {hostError && (
                <div className="mb-3 p-2 rounded text-center" style={{ background: 'rgba(229,9,20,0.18)', border: '1px solid var(--accent-red)', fontSize: '0.9rem' }}>
                  ⚠️ {hostError}
                </div>
              )}

              {/* Always-available timer controls (active phases only) */}
              {(gameState === 'CLUE_REVEAL' || gameState === 'VOTING' || gameState === 'VOTE_RESULT' || gameState === 'PUBLIC_CHARACTER_OVERVIEW' || gameState === 'ROLE_REVEAL') && (
                <div className="grid mb-3" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                  <button className="btn-secondary" onClick={() => handleHostAction('pause')}>إيقاف ⏸️</button>
                  <button className="btn-secondary" onClick={() => handleHostAction('resume')}>استكمال ▶️</button>
                  <button className="btn-secondary" onClick={() => handleHostAction('extend_timer')} style={{ gridColumn: 'span 2' }}>+30 ثانية ⏳</button>
                </div>
              )}

              {/* Phase-aware advance actions */}
              {gameState === 'CLUE_REVEAL' && (
                <button className="btn-primary" onClick={() => handleHostAction('start_voting_now')}>
                  ابدأ التصويت دلوقتي 🔔
                </button>
              )}
              {gameState === 'VOTING' && (
                <button className="btn-primary" onClick={() => handleHostAction('close_voting_now')}>
                  اقفل التصويت دلوقتي 🛑
                </button>
              )}
              {gameState === 'VOTE_RESULT' && !outcome && (
                <button className="btn-primary" onClick={() => handleHostAction('continue_next_round')}>
                  الجولة الجاية ⏭️
                </button>
              )}

              {/* Emergency / session controls (always available to host) */}
              <div className="mt-3 grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                <button className="btn-secondary" onClick={() => handleHostAction('trigger_final_reveal')} style={{ borderColor: 'rgba(212,175,55,0.5)' }}>
                  اعرض الكشف النهائي 🎬
                </button>
                <button className="btn-secondary" onClick={confirmEndSession} style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}>
                  إنهاء الجلسة 🚪
                </button>
              </div>
            </div>
          )}

          <div className="card flex-1 p-4 flex flex-col">
            <h4 className="mb-4 text-main border-b border-gray-700 pb-2">المسجلون بالغرفة ({players.length})</h4>
            <ul className="player-list overflow-y-auto">
              {players.length === 0 && <p className="text-muted text-sm">جاري التحديث...</p>}
              {players.map(p => (
                <li key={p.id} className="player-item" style={{ background: 'transparent', padding: '0.5rem 0', border: 'none', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span>{p.isHost ? '🎩' : '👤'} {p.username} {p.id === user?.id && '(أنت)'}</span>
                  <span className="text-muted" style={{ fontSize: '0.8rem' }}>{p.isHost ? 'المضيف' : 'مشتبه'}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
