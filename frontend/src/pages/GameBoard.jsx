import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { socket, setActiveRoomId, getActiveRoomId } from '../services/socket';
import { getStoredUser } from '../services/api';

// =============================================================================
// ConnectionBanner — top-of-screen toast that reflects socket health.
// Hides itself entirely when the connection is fine.
// =============================================================================
function ConnectionBanner({ status }) {
  if (status === 'connected') return null;
  let cls = 'info', text = '';
  if (status === 'reconnecting') { cls = 'info'; text = 'إعادة الاتصال...'; }
  else if (status === 'disconnected') { cls = 'warn'; text = 'انقطع الاتصال — جار المحاولة'; }
  else if (status === 'recently_reconnected') { cls = 'ok'; text = 'الاتصال رجع تاني ✓'; }
  return <div className={`connection-banner ${cls}`}>{text}</div>;
}

// =============================================================================
// FinalRevealView — cinematic case conclusion
//
// Renders the deterministic payload built by the backend's buildFinalReveal().
// All copy is dynamic per session: real player names, assigned characters,
// suspicious details, actual voting history, real eliminations, real outcome.
// No hard-coded "Player X won" lines.
// =============================================================================
function FinalRevealView({ data, fallbackOutcome, onNewGame, onBackToLobby }) {
  // Recovery if the backend hasn't emitted the reveal yet (rare race / refresh).
  if (!data) {
    return (
      <div className="animate-fade-in text-center w-full final-reveal-section">
        <div className="pulse-animation" style={{ fontSize: '4rem', marginBottom: '1rem' }}>📜</div>
        <h2 className="cinematic-glow mb-2">جاري فك الأرشيف...</h2>
        <p className="text-muted mb-6">
          {fallbackOutcome === 'investigators_win'
            ? 'انتصر التحقيق. الكشف الكامل جاي بعد لحظة.'
            : fallbackOutcome === 'mafiozo_survives'
            ? 'المافيوزو نجا. الحقيقة هتتكشف دلوقتي.'
            : 'الجلسة انتهت. الأرشيف بيتفك.'}
        </p>
        <button className="btn-secondary" onClick={onBackToLobby} style={{ maxWidth: '260px', margin: '0 auto' }}>
          ارجع للساحة
        </button>
      </div>
    );
  }

  const tone = data.winnerTone || 'neutral';
  const accent = tone === 'gold' ? 'var(--accent-gold)' : tone === 'red' ? 'var(--accent-red)' : 'var(--text-main)';
  const accentBg = tone === 'gold' ? 'rgba(212,175,55,0.12)' : tone === 'red' ? 'rgba(229,9,20,0.12)' : 'rgba(255,255,255,0.04)';

  return (
    <div className="animate-fade-in" style={{ width: '100%' }}>
      {/* HERO ---------------------------------------------------------- */}
      <section className="final-reveal-section text-center" style={{ marginBottom: '2rem' }}>
        <div className="text-muted" style={{ fontSize: '0.85rem', letterSpacing: '3px' }}>
          {data.winnerLabel}
        </div>
        <h1 className="cinematic-glow" style={{ fontSize: '2.6rem', color: accent, margin: '0.4rem 0 1rem' }}>
          {data.headline?.title || data.title}
        </h1>
        {data.headline?.subtitle && (
          <p className="text-muted" style={{ fontSize: '1.1rem', maxWidth: '720px', margin: '0 auto', lineHeight: 1.7 }}>
            {data.headline.subtitle}
          </p>
        )}
      </section>

      {/* CASE RECONSTRUCTION ------------------------------------------- */}
      <section className="card final-reveal-section" style={{ padding: '1.5rem', marginBottom: '1.25rem', textAlign: 'right' }}>
        <div className="text-muted" style={{ fontSize: '0.8rem', letterSpacing: '2px' }}>القضية</div>
        <h2 className="golden-text" style={{ fontSize: '1.6rem', margin: '0.25rem 0 1rem' }}>
          {data.caseSummary?.title || data.title}
        </h2>
        {data.caseSummary?.story && (
          <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.85, marginBottom: '1rem' }}>{data.caseSummary.story}</p>
        )}
        {data.caseSummary?.reconstruction && (
          <div style={{ borderInlineStart: '3px solid var(--accent-red)', paddingInlineStart: '1rem', whiteSpace: 'pre-wrap', lineHeight: 1.85, color: '#e0e0e0' }}>
            {data.caseSummary.reconstruction}
          </div>
        )}
        {data.caseSummary?.closingLine && (
          <p className="golden-text" style={{ marginTop: '1rem', fontStyle: 'italic' }}>{data.caseSummary.closingLine}</p>
        )}
      </section>

      {/* TRUTH (mafiozo reveal) --------------------------------------- */}
      {data.truth && (
        <section className="card final-reveal-section reveal-truth-card" style={{
          padding: '1.5rem', marginBottom: '1.25rem', textAlign: 'right',
          background: accentBg, borderColor: accent,
        }}>
          <div className="text-muted" style={{ fontSize: '0.8rem', letterSpacing: '2px' }}>المافيوزو الحقيقي</div>
          <h3 style={{ fontSize: '1.8rem', color: accent, margin: '0.25rem 0 0.5rem', fontWeight: 800 }}>
            {data.truth.mafiozoUsername}
          </h3>
          <p style={{ fontSize: '1.05rem', marginBottom: '0.6rem' }}>
            🎭 شخصية <strong>{data.truth.mafiozoCharacterName}</strong> — <span className="text-muted">{data.truth.mafiozoStoryRole}</span>
          </p>
          <div className="text-muted mb-2" style={{ fontSize: '0.85rem', letterSpacing: '1.5px' }}>التفصيلة المريبة</div>
          <p style={{ fontStyle: 'italic', marginBottom: '0.85rem' }}>!!{data.truth.mafiozoSuspiciousDetail}!!</p>
          <p style={{ lineHeight: 1.85 }}>{data.truth.mafiozoExplanation}</p>
        </section>
      )}

      {/* OBVIOUS SUSPECT ---------------------------------------------- */}
      {data.obviousSuspect && (
        <section className="card final-reveal-section" style={{ padding: '1.5rem', marginBottom: '1.25rem', textAlign: 'right' }}>
          <div className="text-muted" style={{ fontSize: '0.8rem', letterSpacing: '2px' }}>المشتبه الواضح</div>
          <h3 className="golden-text" style={{ fontSize: '1.4rem', margin: '0.25rem 0 0.5rem' }}>
            {data.obviousSuspect.username}
          </h3>
          <p style={{ fontSize: '1rem', marginBottom: '0.6rem' }}>
            🎭 {data.obviousSuspect.characterName} — <span className="text-muted">{data.obviousSuspect.storyRole}</span>
          </p>
          <p className="text-muted" style={{ fontStyle: 'italic', marginBottom: '0.6rem' }}>!!{data.obviousSuspect.suspiciousDetail}!!</p>
          <p style={{ lineHeight: 1.8 }}>{data.obviousSuspect.explanation}</p>
        </section>
      )}

      {/* PLAYER ROSTER ------------------------------------------------ */}
      {Array.isArray(data.players) && data.players.length > 0 && (
        <section className="final-reveal-section" style={{ marginBottom: '1.25rem' }}>
          <h3 className="golden-text mb-2" style={{ fontSize: '1.3rem', textAlign: 'right' }}>اللاعبين والشخصيات</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.8rem' }}>
            {data.players.map(p => (
              <div key={p.playerId} className="card" style={{
                padding: '0.85rem',
                textAlign: 'right',
                borderColor: p.gameRole === 'mafiozo' ? 'var(--accent-red)' : p.gameRole === 'obvious_suspect' ? 'var(--accent-gold)' : 'var(--border-subtle)',
                background: p.gameRole === 'mafiozo' ? 'rgba(229,9,20,0.1)' : p.gameRole === 'obvious_suspect' ? 'rgba(212,175,55,0.08)' : 'rgba(0,0,0,0.4)',
              }}>
                <div className="golden-text" style={{ fontSize: '1rem', fontWeight: 700 }}>{p.username}</div>
                <div style={{ fontSize: '0.95rem', marginTop: '0.3rem' }}>
                  🎭 {p.characterName} <span className="text-muted">— {p.storyRole}</span>
                </div>
                <div className="text-muted" style={{ fontSize: '0.78rem', fontStyle: 'italic', marginTop: '0.4rem' }}>
                  !!{p.suspiciousDetail}!!
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.6rem', fontSize: '0.85rem' }}>
                  <span style={{
                    color: p.gameRole === 'mafiozo' ? 'var(--accent-red)' : p.gameRole === 'obvious_suspect' ? 'var(--accent-gold)' : 'var(--text-muted)',
                    fontWeight: 700,
                  }}>
                    {p.roleLabelArabic || '—'}
                  </span>
                  <span className="text-muted">
                    {p.survived
                      ? '✓ نجا'
                      : `✕ خرج في الجولة ${p.eliminatedRound || '?'}`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* CLUE ANALYSIS ------------------------------------------------ */}
      {Array.isArray(data.clues) && data.clues.length > 0 && (
        <section className="final-reveal-section" style={{ marginBottom: '1.25rem' }}>
          <h3 className="golden-text mb-2" style={{ fontSize: '1.3rem', textAlign: 'right' }}>قراءة الأدلة</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.85rem' }}>
            {data.clues.map(c => (
              <div key={c.index} className="card" style={{ padding: '1rem', textAlign: 'right' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span className="golden-text" style={{ fontWeight: 700 }}>الدليل {c.index + 1}</span>
                  <span className="text-muted" style={{ fontSize: '0.8rem', letterSpacing: '1.5px' }}>{c.typeLabel}</span>
                </div>
                <p className="cinematic-glow" style={{ fontSize: '1rem', marginBottom: '0.8rem', lineHeight: 1.7 }}>"{c.text}"</p>
                <div style={{ marginBottom: '0.5rem' }}>
                  <div className="text-muted" style={{ fontSize: '0.78rem', letterSpacing: '1.5px' }}>اللي شافتوه الساحة</div>
                  <p style={{ fontSize: '0.92rem', lineHeight: 1.7 }}>{c.surfaceMeaning}</p>
                </div>
                <div>
                  <div className="text-muted" style={{ fontSize: '0.78rem', letterSpacing: '1.5px' }}>الحقيقة</div>
                  <p style={{ fontSize: '0.92rem', lineHeight: 1.7, color: '#e8e8e8' }}>{c.realMeaning}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* VOTING TIMELINE ---------------------------------------------- */}
      {Array.isArray(data.votingTimeline) && data.votingTimeline.length > 0 && (
        <section className="final-reveal-section" style={{ marginBottom: '1.25rem' }}>
          <h3 className="golden-text mb-2" style={{ fontSize: '1.3rem', textAlign: 'right' }}>سجل التصويت</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
            {data.votingTimeline.map(r => (
              <div key={r.round} className="card" style={{
                padding: '0.85rem 1rem',
                textAlign: 'right',
                borderInlineStart: `4px solid ${r.wasMafiozo ? 'var(--accent-gold)' : r.eliminatedId ? 'var(--accent-red)' : 'var(--border-subtle)'}`,
              }}>
                <div className="golden-text" style={{ fontSize: '0.95rem', fontWeight: 700 }}>الجولة {r.round}</div>
                <p style={{ fontSize: '0.95rem', lineHeight: 1.7, marginTop: '0.35rem' }}>{r.summary}</p>
                {r.tally && Object.keys(r.tally).length > 0 && (
                  <div className="text-muted" style={{ fontSize: '0.78rem', marginTop: '0.4rem' }}>
                    {Object.entries(r.tally)
                      .sort((a, b) => b[1] - a[1])
                      .map(([k, v]) => `${k === 'skip' ? 'امتناع' : k} (${v})`)
                      .join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* DRAMATIC BEATS ----------------------------------------------- */}
      {Array.isArray(data.dramaticBeats) && data.dramaticBeats.length > 0 && (
        <section className="final-reveal-section" style={{ marginBottom: '1.25rem' }}>
          <h3 className="golden-text mb-2" style={{ fontSize: '1.3rem', textAlign: 'right' }}>لحظات حاسمة</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {data.dramaticBeats.map((beat, i) => (
              <li key={i} className="card" style={{ padding: '0.6rem 0.9rem', textAlign: 'right', fontSize: '0.95rem', lineHeight: 1.7 }}>
                <span className="golden-text" style={{ marginInlineEnd: '0.4rem' }}>◆</span>{beat}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* BLIND-MODE CODA ---------------------------------------------- */}
      {data.roleRevealMode === 'blind' && (
        <section className="card final-reveal-section" style={{
          padding: '1.25rem', marginBottom: '1.25rem', textAlign: 'right',
          background: 'rgba(229,9,20,0.08)', borderColor: 'rgba(229,9,20,0.4)',
        }}>
          <div className="text-muted" style={{ fontSize: '0.8rem', letterSpacing: '2px' }}>طور عمياني</div>
          <p style={{ fontSize: '1rem', lineHeight: 1.85, margin: '0.4rem 0 0' }}>
            اللعبة كانت عمياني، والحقيقة كانت متدارية حتى عن أصحابها. كل لاعب كان شايف تفصيلته المريبة، لكن محدش كان ماسك الصورة كاملة.
          </p>
        </section>
      )}

      {/* FINAL PARAGRAPH ---------------------------------------------- */}
      {data.finalParagraph && (
        <section className="card final-reveal-section" style={{
          padding: '1.5rem', marginBottom: '1.5rem', textAlign: 'right',
          background: 'rgba(0,0,0,0.5)',
          borderColor: accent,
        }}>
          <p className="cinematic-glow" style={{ fontSize: '1.1rem', lineHeight: 2, margin: 0 }}>
            {data.finalParagraph}
          </p>
        </section>
      )}

      {/* CTAS --------------------------------------------------------- */}
      <div className="text-center" style={{ display: 'flex', gap: '0.8rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <button className="btn-primary" onClick={onNewGame} style={{ minWidth: '220px' }}>
          {data.ctas?.newGame || 'ابدأ جلسة جديدة'} 🎬
        </button>
        <button className="btn-secondary" onClick={onBackToLobby} style={{ minWidth: '180px' }}>
          {data.ctas?.backToLobby || 'ارجع للساحة'}
        </button>
      </div>
    </div>
  );
}

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
  const [hostSuccess, setHostSuccess] = useState(''); // brief confirmation for host actions
  const [sessionEnded, setSessionEnded] = useState(false);
  const [finalReveal, setFinalReveal] = useState(null);
  // Connection: 'connected' | 'reconnecting' | 'disconnected' | 'recently_reconnected'
  const [connectionStatus, setConnectionStatus] = useState(socket.connected ? 'connected' : 'reconnecting');

  // Reset per-round transient state when we enter a new VOTING round.
  useEffect(() => {
    if (gameState === 'VOTING') {
      setMyVote(null);
      setVoteError('');
      setVoteResult(null);
    }
  }, [gameState]);

  // Connection status banner — driven by socket lifecycle events.
  useEffect(() => {
    let recoveryTimer = null;
    const onConnect = () => {
      setConnectionStatus(prev => {
        if (prev === 'disconnected' || prev === 'reconnecting') {
          // Briefly show "الاتصال رجع تاني", then fade.
          if (recoveryTimer) clearTimeout(recoveryTimer);
          recoveryTimer = setTimeout(() => setConnectionStatus('connected'), 2500);
          return 'recently_reconnected';
        }
        return 'connected';
      });
    };
    const onDisconnect = () => setConnectionStatus('disconnected');
    const onReconnectAttempt = () => setConnectionStatus('reconnecting');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    return () => {
      if (recoveryTimer) clearTimeout(recoveryTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
    };
  }, []);

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
      if (data.finalReveal !== undefined) setFinalReveal(data.finalReveal || null);
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

  // Friendly Arabic success label for each host action.
  const HOST_ACTION_OK_LABEL = {
    pause: 'اللعبة اتوقّفت مؤقتاً',
    resume: 'اللعبة استكملت',
    extend_timer: 'تم إضافة 30 ثانية',
    start_first_clue: 'الجولة الأولى بدأت',
    skip_public_overview: 'الدليل الأول جاي',
    start_voting_now: 'التصويت اتفتح',
    end_discussion_now: 'التصويت اتفتح',
    close_voting_now: 'التصويت اتقفل',
    continue_next_round: 'الجولة الجاية بدأت',
    reveal_next_clue: 'الجولة الجاية بدأت',
    trigger_final_reveal: 'الكشف النهائي بدأ',
    end_session: 'الجلسة اتقفلت',
  };

  // Named host action — server may ack with `{ success, error }`.
  const handleHostAction = (action) => {
    setHostError('');
    setHostSuccess('');
    socket.emit('host_control', { action, roomId }, (resp) => {
      if (resp && resp.success === false && resp.error) {
        setHostError(resp.error);
        setTimeout(() => setHostError(''), 3500);
      } else if (resp && resp.success) {
        const label = HOST_ACTION_OK_LABEL[action] || 'تم';
        setHostSuccess(label);
        setTimeout(() => setHostSuccess(''), 1800);
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
      <>
        <ConnectionBanner status={connectionStatus} />
        <div className="container animate-fade-in" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
          <div className="card text-center max-w-md mx-auto" style={{ padding: '2.5rem' }}>
            <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🚪</div>
            <h2 className="cinematic-glow mb-3">المضيف أنهى الجلسة</h2>
            <p className="text-muted mb-6">يلا نبدأ غرفة جديدة؟</p>
            <button className="btn-primary" onClick={() => navigate('/lobby')}>ارجع للساحة</button>
          </div>
        </div>
      </>
    );
  }

  if (gameState === 'NOT_FOUND') {
    return (
      <>
        <ConnectionBanner status={connectionStatus} />
        <div className="container animate-fade-in" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
          <div className="card text-center max-w-md mx-auto" style={{ padding: '2.5rem' }}>
            <div style={{ fontSize: '4rem', marginBottom: '1rem', filter: 'drop-shadow(0 0 20px rgba(229,9,20,0.4))' }}>🚪</div>
            <h2 className="cinematic-glow mb-4">تعذر استعادة الغرفة</h2>
            <p className="text-muted mb-6">الغرفة انتهت أو غير موجودة. ارجع للساحة وابدأ غرفة جديدة.</p>
            <button className="btn-primary" onClick={() => navigate('/lobby')}>ارجع للساحة</button>
          </div>
        </div>
      </>
    );
  }
  if (gameState === 'LOADING') {
    return (
      <>
        <ConnectionBanner status={connectionStatus} />
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
      </>
    );
  }

  // ----- ROLE_REVEAL: each player sees their own private card -------------
  if (gameState === 'ROLE_REVEAL') {
    const isBlind = roleRevealMode === 'blind' || roleCard?.mode === 'blind';
    return (
      <>
      <ConnectionBanner status={connectionStatus} />
      {amIHost ? (
        // -------- Host view: full overview, never reveals hidden roles --
        <div style={{ maxWidth: '900px', margin: '0 auto', padding: 'var(--ak-space-5)' }}>
          <div style={{ textAlign: 'center', marginBottom: 'var(--ak-space-5)' }}>
            <span className="ak-overline">Role Distribution · Round 0</span>
            <h1 style={{ margin: 'var(--ak-space-2) 0 var(--ak-space-2)' }}>تم توزيع الشخصيات</h1>
            <p style={{ color: 'var(--ak-text-muted)', fontFamily: 'var(--ak-font-mono)', direction: 'ltr' }}>
              00:{Math.max(0, timer).toString().padStart(2, '0')}
            </p>
            <p style={{ color: 'var(--ak-text-muted)', maxWidth: '560px', margin: '0 auto' }}>
              راجع التوزيع بسرعة. الأدوار الخفية محفوظة، اللاعبين شايفين بطاقاتهم بس.
            </p>
          </div>

          <div className="host-overview-grid">
            {publicCards.map(c => (
              <div key={c.playerId} className="ak-card ak-card-surface" style={{ padding: 'var(--ak-space-4)' }}>
                <div style={{ color: 'var(--ak-gold)', font: 'var(--ak-t-h4)', marginBottom: 'var(--ak-space-1)' }}>{c.username}</div>
                <div style={{ marginBottom: 'var(--ak-space-2)' }}>
                  {c.storyCharacterName}
                  <span style={{ color: 'var(--ak-text-muted)' }}> — {c.storyCharacterRole}</span>
                </div>
                <div style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-body-sm)', fontStyle: 'italic' }}>
                  !!{c.suspiciousDetail}!!
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 'var(--ak-space-3)', justifyContent: 'center', flexWrap: 'wrap', marginTop: 'var(--ak-space-5)' }}>
            <button className="ak-btn ak-btn-primary" onClick={() => handleHostAction('start_first_clue')} style={{ minWidth: '260px' }}>
              ابدأ الجولة الأولى
            </button>
            <button className="ak-btn ak-btn-ghost" onClick={confirmEndSession}>إنهاء الجلسة</button>
          </div>
          {hostError && (
            <div className="s-auth-error" style={{ marginTop: 'var(--ak-space-3)', maxWidth: '480px', marginInline: 'auto' }}>⚠ {hostError}</div>
          )}
        </div>
      ) : (
        // -------- Player view: private role card -----------------------
        <div className="s-reveal">
          <div className="s-reveal-shell">
            <div className="s-reveal-timer">00:{Math.max(0, timer).toString().padStart(2, '0')}</div>

            {!roleCard ? (
              <div className="role-card animate-fade-in" style={{ minHeight: '380px', justifyContent: 'center', textAlign: 'center' }}>
                <span className="ov">Sealing</span>
                <div className="seal pulse-animation" aria-hidden>كـ</div>
                <h3 className="character-name" style={{ font: 'var(--ak-t-h3)' }}>الكبير بيوزع البطاقات</h3>
                <p className="character-role">استنى لحظة...</p>
              </div>
            ) : (
              <div className={`role-card animate-fade-in${isBlind ? ' blind' : ''}`}>
                <span className="ov">Your Identity</span>
                <div className="seal" aria-hidden>
                  {isBlind ? '?' : (roleCard.storyCharacterName || '?').trim().charAt(0)}
                </div>
                <div>
                  <h3 className="character-name">{roleCard.storyCharacterName}</h3>
                  <p className="character-role">{roleCard.storyCharacterRole}</p>
                </div>

                <div className="role-section">
                  <span className="label">التفصيلة المريبة</span>
                  <div className="value">!!{roleCard.suspiciousDetail}!!</div>
                </div>

                {!isBlind && roleCard.gameRole && (
                  <div className={`secret-banner${roleCard.gameRole === 'mafiozo' ? '' : roleCard.gameRole === 'obvious_suspect' ? ' gold' : ' muted'}`}>
                    <span className="label-en">Hidden Identity</span>
                    <h3>{roleCard.roleLabelArabic}</h3>
                    {roleCard.objective && <p>{roleCard.objective}</p>}
                  </div>
                )}

                {isBlind && (
                  <div className="secret-banner">
                    <span className="label-en">Blind Mode</span>
                    <h3>الحقيقة مش كاملة عند حد</h3>
                    <p>{roleCard.objective || 'راقب، اسأل، ودافع عن نفسك. الحقيقة الكاملة بتظهر في الكشف النهائي.'}</p>
                  </div>
                )}

                <p className="warning">⚠ {roleCard.warning || 'ممنوع تكشف بطاقتك للاعبين التانيين.'}</p>
              </div>
            )}
          </div>
        </div>
      )}
      </>
    );
  }

  // ----- PUBLIC_CHARACTER_OVERVIEW: 10 s public summary -------------------
  if (gameState === 'PUBLIC_CHARACTER_OVERVIEW') {
    return (
      <>
      <ConnectionBanner status={connectionStatus} />
      <div className="s-public animate-fade-in">
        <div className="s-public-head">
          <span className="ak-overline">Round 0 · Setup</span>
          <h1>الشخصيات على الطاولة</h1>
          <p style={{ color: 'var(--ak-text-muted)', maxWidth: '560px', margin: '0 auto var(--ak-space-2)' }}>
            قدامكم وقت قصير تحفظوا مين مين، وبعدها التحقيق يبدأ.
          </p>
          <span className="countdown">00:{Math.max(0, timer).toString().padStart(2, '0')}</span>
        </div>

        <div className="s-public-grid">
          {publicCards.map(c => (
            <div key={c.playerId} className="s-public-card animate-fade-in">
              <div className="player-name">{c.username}</div>
              <div className="character">
                {c.storyCharacterName}<span className="role"> — {c.storyCharacterRole}</span>
              </div>
              <div className="detail">!!{c.suspiciousDetail}!!</div>
            </div>
          ))}
        </div>

        {amIHost && (
          <div style={{ textAlign: 'center', marginTop: 'var(--ak-space-5)' }}>
            <button className="ak-btn ak-btn-primary" onClick={() => handleHostAction('skip_public_overview')} style={{ minWidth: '260px' }}>
              ابدأ الدليل الأول
            </button>
            {hostError && (
              <div className="s-auth-error" style={{ marginTop: 'var(--ak-space-3)', maxWidth: '480px', marginInline: 'auto' }}>⚠ {hostError}</div>
            )}
          </div>
        )}
      </div>
      </>
    );
  }

  // ----- FINAL_REVEAL / POST_GAME (full-width cinematic reveal) -----------
  if (gameState === 'FINAL_REVEAL' || gameState === 'POST_GAME') {
    return (
      <>
        <ConnectionBanner status={connectionStatus} />
        <div className="container mt-2 animate-fade-in" style={{ maxWidth: '1100px' }}>
          <FinalRevealView
            data={finalReveal}
            fallbackOutcome={outcome}
            onNewGame={() => { setFinalReveal(null); navigate('/lobby'); }}
            onBackToLobby={() => navigate('/lobby')}
          />
        </div>
      </>
    );
  }

  // ----- main arena (CLUE_REVEAL / VOTING / POST_GAME / legacy ARCHIVE_LOCKED)
  return (
    <>
    <ConnectionBanner status={connectionStatus} />
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
              <span className="phase-pill">الدليل {Math.min(clueIndex + 1, totalClues)} من {totalClues}</span>
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
            const iHaveVoted = canVote && myVote !== null && myVote !== undefined;
            const everyoneVoted = votingProgress.total > 0 && votingProgress.voted >= votingProgress.total;
            return (
              <div className="animate-fade-in text-center w-full">
                <span className="phase-pill danger">التصويت · جولة {Math.min(clueIndex + 1, totalClues)} من {totalClues}</span>
                <div className="mb-3 pulse-animation" style={{ fontSize: '3.5rem' }}>⚠️</div>
                <h1 className="cinematic-glow mb-2" style={{ fontSize: '2.6rem' }}>حان وقت الحُكم</h1>
                <p className="text-muted mb-2" style={{ fontSize: '1.05rem' }}>
                  مين المشتبه فيه النوبة دي؟
                </p>
                <p className="golden-text mb-4" style={{ fontSize: '1rem' }}>
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
                {iHaveVoted && !everyoneVoted && (
                  <div className="mb-4 mx-auto p-3 rounded golden-text" style={{ background: 'rgba(212,175,55,0.10)', border: '1px solid rgba(212,175,55,0.45)', maxWidth: '480px' }}>
                    ✓ صوّتت — مستني باقي اللاعبين ({votingProgress.total - votingProgress.voted} متبقي)
                  </div>
                )}

                <div className="voting-grid flex justify-center flex-wrap gap-4 mx-auto" style={{ maxWidth: '80%' }}>
                  {aliveNonHost.map(p => {
                    const selected = myVote === p.id;
                    return (
                      <button
                        key={p.id}
                        className={`btn-secondary ${selected ? 'vote-pressed' : ''}`}
                        disabled={!canVote}
                        style={{
                          width: '45%',
                          fontSize: '1.2rem',
                          padding: '1.5rem',
                          background: selected ? 'var(--accent-red)' : '',
                          borderColor: selected ? 'var(--accent-red)' : 'var(--border-subtle)',
                          opacity: canVote ? 1 : 0.55,
                          cursor: canVote ? 'pointer' : 'not-allowed',
                        }}
                        onClick={() => canVote && handleVote(p.id)}
                      >
                        {p.username} {selected && '✅'}
                      </button>
                    );
                  })}
                  {(() => {
                    const skipSelected = myVote === 'skip';
                    return (
                      <button
                        className={`btn-secondary ${skipSelected ? 'vote-pressed' : ''}`}
                        disabled={!canVote}
                        style={{
                          width: '45%',
                          fontSize: '1.2rem',
                          padding: '1.5rem',
                          background: skipSelected ? '#555' : '',
                          opacity: canVote ? 1 : 0.55,
                          cursor: canVote ? 'pointer' : 'not-allowed',
                        }}
                        onClick={() => canVote && handleVote('skip')}
                      >
                        امتناع عن التصويت {skipSelected && '✅'}
                      </button>
                    );
                  })()}
                </div>
              </div>
            );
          })()}

          {gameState === 'VOTE_RESULT' && voteResult && (() => {
            const elim = voteResult.eliminatedUsername;
            const isLastRound = voteResult.round >= totalClues;
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
            // Outcome-aware next-step copy.
            let subText;
            if (voteResult.reason === 'majority' && voteResult.wasMafiozo) {
              subText = 'الحقيقة اتكشفت. الأرشيف بيتفك دلوقتي.';
            } else if (voteResult.reason === 'majority' && !voteResult.wasMafiozo) {
              subText = isLastRound
                ? 'الكشف ضاع — المافيوزو لسه وسطكم.'
                : 'الدليل الجاي هيقرّبكم من الحقيقة.';
            } else if (voteResult.reason === 'tie' || voteResult.reason === 'no-vote' || voteResult.reason === 'all-skip') {
              subText = isLastRound
                ? 'مفيش حسم في الجولة الأخيرة — المافيوزو لسه وسطكم.'
                : 'الجولة عدّت بدون حسم. الدليل الجاي طريقكم.';
            } else {
              subText = 'الجولة الجاية هتبدأ بدليل جديد.';
            }
            const accent = voteResult.reason === 'majority' && voteResult.wasMafiozo
              ? 'var(--accent-gold)'
              : voteResult.reason === 'majority'
                ? 'var(--accent-red)'
                : 'var(--text-muted)';
            return (
              <div className="animate-fade-in text-center w-full">
                <span className="phase-pill">نتيجة الجولة {voteResult.round} من {totalClues}</span>
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

        </div>

        <div className="flex flex-col gap-6" style={{ flex: '1 1 30%', minWidth: '350px' }}>
          {amIHost && (
            <div className="card p-4" style={{ background: 'rgba(20, 0, 0, 0.4)', border: '1px solid rgba(229, 9, 20, 0.3)' }}>
              <h4 className="golden-text mb-3"><span>🕹️</span> لوحة تحكم الكبير</h4>

              {hostError && (
                <div className="host-toast err mb-3 text-center" style={{ display: 'block', fontSize: '0.9rem' }}>
                  ⚠️ {hostError}
                </div>
              )}
              {hostSuccess && !hostError && (
                <div className="host-toast ok mb-3 text-center" style={{ display: 'block', fontSize: '0.9rem' }}>
                  ✓ {hostSuccess}
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
    </>
  );
}
