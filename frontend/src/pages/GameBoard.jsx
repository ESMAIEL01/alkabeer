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
function FinalRevealView({ data, aiPolish, fallbackOutcome, onNewGame, onBackToLobby, onViewReport }) {
  const [shareCopied, setShareCopied] = useState(false);
  const [shareError, setShareError] = useState(false);
  const shareTextareaRef = useRef(null);

  // Recovery if the backend hasn't emitted the reveal yet (rare race / refresh).
  if (!data) {
    return (
      <div className="s-final animate-fade-in">
        <div className="s-seal-waiting">
          <img
            src="/design/scene-archive-book.png"
            alt=""
            aria-hidden="true"
            className="s-seal-book"
          />
          <p className="ak-overline s-seal-overline">PROTOCOL ZERO · فك التشفير</p>
          <h2 className="s-seal-headline">الكبير بيفك الأرشيف</h2>
          <p className="s-seal-sub">
            {fallbackOutcome === 'investigators_win'
              ? 'انتصر التحقيق. الحقيقة هتتكشف دلوقتي.'
              : fallbackOutcome === 'mafiozo_survives'
              ? 'المافيوزو نجا. الكشف النهائي قادم.'
              : 'الجلسة انتهت. الأرشيف بيتفك.'}
          </p>
          <div className="s-seal-bar" aria-hidden="true">
            <div className="s-seal-bar-fill" />
          </div>
          <button className="ak-btn ak-btn-ghost" onClick={onBackToLobby} style={{ minWidth: '220px' }}>ارجع للساحة</button>
        </div>
      </div>
    );
  }

  const tone = data.winnerTone || 'neutral';
  const headlineCls = tone === 'gold' ? 'gold' : tone === 'red' ? 'crimson' : '';
  const truthCls    = tone === 'gold' ? 'gold' : '';
  const closingCls  = tone === 'gold' ? '' : 'crimson';

  // Optional AI polish (C3) — overlay-only. Each field is independently
  // optional. Deterministic fields stay primary; aiPolish never replaces
  // headline/title/outcome/role/voting truth.
  const polish = aiPolish && typeof aiPolish === 'object' ? aiPolish : null;
  const heroSubtitle = (polish && polish.heroSubtitle) || data.headline?.subtitle || null;
  const closingLine  = (polish && polish.caseClosingLine) || data.caseSummary?.closingLine || null;

  // Resolve mafiozos array once — the rest of this view, the share card,
  // and the summary stats all read from the same source of truth.
  const mafiozosArr = Array.isArray(data.truth?.mafiozos) && data.truth.mafiozos.length > 0
    ? data.truth.mafiozos
    : (data.truth?.mafiozoUsername
        ? [{
            playerId:         data.truth.mafiozoPlayerId,
            username:         data.truth.mafiozoUsername,
            characterName:    data.truth.mafiozoCharacterName,
            storyRole:        data.truth.mafiozoStoryRole,
            suspiciousDetail: data.truth.mafiozoSuspiciousDetail,
            explanation:      data.truth.mafiozoExplanation,
            eliminatedAtRound: null,
            survived: null,
          }]
        : []);

  const playersArr = Array.isArray(data.players) ? data.players : [];
  const cluesArr = Array.isArray(data.clues) ? data.clues : [];
  const roundsCount = Array.isArray(data.votingTimeline) ? data.votingTimeline.length : 0;

  // Deciding clue spotlight — prefer one explicitly tagged by the backend
  // (typeLabel mentions "حاسم"); else fall back to the last clue, which
  // is the one most likely to have closed the loop.
  let decidingClue = null;
  if (cluesArr.length > 0) {
    decidingClue = cluesArr.find(c => typeof c.typeLabel === 'string' && /حاسم/.test(c.typeLabel))
      || cluesArr[cluesArr.length - 1];
  }

  // Innocents block — surviving non-mafiozo, non-obvious-suspect players who
  // helped close the case. Limit to 4 to keep the section scannable on mobile.
  const innocents = playersArr
    .filter(p => p.gameRole !== 'mafiozo' && p.gameRole !== 'obvious_suspect' && p.survived !== false)
    .slice(0, 4);

  // Stats for the at-a-glance row + the share card.
  const stats = {
    players:   playersArr.length || null,
    clues:     cluesArr.length || null,
    mafiozos:  mafiozosArr.length || null,
    rounds:    roundsCount || null,
  };

  // --- Share card -----------------------------------------------------------
  // Builds a copy-friendly Arabic summary. Pure DOM; no canvas, no upload, no
  // image generation. The user can take a screenshot of the on-screen card.
  function buildShareSummary() {
    const lines = [];
    lines.push('الكبير · مافيوزو');
    if (data.winnerLabel) lines.push(`النتيجة: ${data.winnerLabel}`);
    const caseTitle = data.caseSummary?.title || data.title || data.headline?.title;
    if (caseTitle) lines.push(`القضية: ${caseTitle}`);
    const statBits = [];
    if (stats.players)  statBits.push(`لاعبين: ${stats.players}`);
    if (stats.clues)    statBits.push(`أدلة: ${stats.clues}`);
    if (stats.mafiozos) statBits.push(`مافيوزو: ${stats.mafiozos}`);
    if (stats.rounds)   statBits.push(`جولات: ${stats.rounds}`);
    if (statBits.length > 0) lines.push(statBits.join(' · '));
    if (mafiozosArr.length > 0) {
      const names = mafiozosArr.map(m => m.username).filter(Boolean).join('، ');
      if (names) lines.push(`مافيوزو الجلسة: ${names}`);
    }
    if (closingLine) lines.push(closingLine);
    return lines.join('\n');
  }
  const shareSummary = buildShareSummary();

  async function handleCopyShare() {
    setShareError(false);
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareSummary);
      } else if (shareTextareaRef.current) {
        shareTextareaRef.current.select();
        const ok = document.execCommand && document.execCommand('copy');
        if (!ok) throw new Error('copy-blocked');
      } else {
        throw new Error('clipboard-unsupported');
      }
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2200);
    } catch {
      setShareError(true);
      if (shareTextareaRef.current) {
        shareTextareaRef.current.removeAttribute('readonly');
        shareTextareaRef.current.focus();
        shareTextareaRef.current.select();
      }
    }
  }

  return (
    <div className="s-final animate-fade-in">
      {/* HERO ---------------------------------------------------------- */}
      <section className="s-final-hero final-reveal-section">
        <span className="winner-label">{data.winnerLabel}</span>
        <h1 className={`s-final-verdict ${headlineCls}`}>{data.headline?.title || data.title}</h1>
        {heroSubtitle && <p className="s-final-verdict-sub">{heroSubtitle}</p>}
        {(stats.players || stats.clues || stats.mafiozos || stats.rounds) && (
          <ul className="s-final-stats" aria-label="ملخص الجلسة">
            {stats.players != null && (
              <li><span className="num">{stats.players}</span><span className="lbl">لاعبين</span></li>
            )}
            {stats.clues != null && (
              <li><span className="num">{stats.clues}</span><span className="lbl">أدلة</span></li>
            )}
            {stats.mafiozos != null && (
              <li><span className="num">{stats.mafiozos}</span><span className="lbl">مافيوزو</span></li>
            )}
            {stats.rounds != null && (
              <li><span className="num">{stats.rounds}</span><span className="lbl">جولات</span></li>
            )}
          </ul>
        )}
      </section>

      {/* CASE RECONSTRUCTION ------------------------------------------- */}
      <section className="s-final-section final-reveal-section">
        <span className="section-overline">The Case · القضية</span>
        <div className="s-final-case">
          <h2>{data.caseSummary?.title || data.title}</h2>
          {data.caseSummary?.story && <p className="story">{data.caseSummary.story}</p>}
          {data.caseSummary?.reconstruction && (
            <div className="reconstruction">{data.caseSummary.reconstruction}</div>
          )}
          {polish && polish.finalParagraph && (
            <p className="story" style={{ fontStyle: 'italic', color: 'var(--ak-text-muted)', marginTop: 'var(--ak-space-3)' }}>
              {polish.finalParagraph}
            </p>
          )}
          {closingLine && <p className="closing">{closingLine}</p>}
          {polish && polish.epilogue && (
            <p className="closing" style={{ marginTop: 'var(--ak-space-3)', fontStyle: 'italic', opacity: 0.85 }}>
              {polish.epilogue}
            </p>
          )}
        </div>
      </section>

      {/* TRUTH (mafiozo reveal) — E3 multi-Mafiozo aware ---------------- */}
      {mafiozosArr.length > 0 && (() => {
        const isMulti = mafiozosArr.length > 1;
        return (
          <section className="s-final-section final-reveal-section">
            <span className="section-overline">
              {isMulti ? 'The Mafiosos · المافيوزو' : 'The Truth · الحقيقة'}
            </span>
            {isMulti && (
              <p style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-caption)', marginTop: 0, marginBottom: 'var(--ak-space-3)' }}>
                الظل كان له أكتر من وجه — {mafiozosArr.length} مافيوزو شغّالين في نفس القضية.
              </p>
            )}
            {mafiozosArr.map((m, i) => (
              <div key={m.playerId || i} className={`s-final-truth ${truthCls}`} style={isMulti ? { marginBottom: 'var(--ak-space-3)' } : null}>
                <span style={{ font: 'var(--ak-t-overline)', color: 'var(--ak-gold)', letterSpacing: 'var(--ak-tracking-x-wide)', textTransform: 'uppercase', direction: 'ltr', display: 'block' }}>
                  {isMulti ? `The Mafioso · ${i + 1}/${mafiozosArr.length}` : 'The Mafioso'}
                </span>
                {isMulti && (
                  <span style={{ font: 'var(--ak-t-caption)', color: 'var(--ak-text-muted)', display: 'block', marginBottom: 'var(--ak-space-1)' }}>
                    مافيوزو {i + 1} من {mafiozosArr.length}
                  </span>
                )}
                <h3 className="accent-name">{m.username}</h3>
                <p className="character-line">
                  شخصية <strong>{m.characterName}</strong>
                  {m.storyRole && <> — <span style={{ color: 'var(--ak-text-muted)' }}>{m.storyRole}</span></>}
                </p>
                <div style={{ font: 'var(--ak-t-caption)', color: 'var(--ak-text-muted)', marginBottom: 'var(--ak-space-2)', letterSpacing: 'var(--ak-tracking-wide)' }}>
                  التفصيلة المريبة
                </div>
                <p className="detail">!!{m.suspiciousDetail}!!</p>
                <p className="explanation">{m.explanation}</p>
                {m.eliminatedAtRound != null && (
                  <p style={{ color: 'var(--ak-gold)', font: 'var(--ak-t-caption)', marginTop: 'var(--ak-space-2)' }}>
                    خرج في الجولة {m.eliminatedAtRound}
                  </p>
                )}
                {m.survived === true && (
                  <p style={{ color: 'var(--ak-crimson-stage)', font: 'var(--ak-t-caption)', marginTop: 'var(--ak-space-2)' }}>
                    نجى لآخر الجلسة.
                  </p>
                )}
              </div>
            ))}
          </section>
        );
      })()}

      {/* DECIDING CLUE — single highlighted clue that closed the case --- */}
      {decidingClue && (
        <section className="s-final-section final-reveal-section">
          <span className="section-overline">Decisive Thread · الخيط الحاسم</span>
          <div className={`s-final-deciding ${tone === 'gold' ? 'gold' : 'crimson'}`}>
            <span className="s-final-deciding-num">الدليل {decidingClue.index + 1}</span>
            <blockquote>"{decidingClue.text}"</blockquote>
            {decidingClue.realMeaning && (
              <p className="s-final-deciding-real">{decidingClue.realMeaning}</p>
            )}
          </div>
        </section>
      )}

      {/* INNOCENT EYES — investigators who helped close the case -------- */}
      {innocents.length > 0 && (
        <section className="s-final-section final-reveal-section">
          <span className="section-overline">The Innocent Eyes · عيون شافت</span>
          <p style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-caption)', marginTop: 0, marginBottom: 'var(--ak-space-3)' }}>
            مش كل مشتبه فيه كان مذنب. دول لاعبين ساعدوا في كشف الحقيقة.
          </p>
          <div className="s-final-innocents">
            {innocents.map(p => (
              <div key={p.playerId} className="s-final-innocent">
                <div className="s-final-innocent-name">{p.username}</div>
                <div className="s-final-innocent-char">
                  {p.characterName}
                  {p.storyRole && <span> — <span style={{ color: 'var(--ak-text-muted)' }}>{p.storyRole}</span></span>}
                </div>
                {p.suspiciousDetail && (
                  <p className="s-final-innocent-det">{p.suspiciousDetail}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* OBVIOUS SUSPECT ---------------------------------------------- */}
      {data.obviousSuspect && (
        <section className="s-final-section final-reveal-section">
          <span className="section-overline">Obvious Suspect · المشتبه الواضح</span>
          <div className="s-final-card gold-edge">
            <h3 className="role-name">{data.obviousSuspect.username}</h3>
            <p className="character-line">
              {data.obviousSuspect.characterName}
              <span style={{ color: 'var(--ak-text-muted)' }}> — {data.obviousSuspect.storyRole}</span>
            </p>
            <p className="detail">!!{data.obviousSuspect.suspiciousDetail}!!</p>
            <p>{data.obviousSuspect.explanation}</p>
          </div>
        </section>
      )}

      {/* PLAYER ROSTER ------------------------------------------------ */}
      {playersArr.length > 0 && (
        <section className="s-final-section final-reveal-section">
          <span className="section-overline">Players · اللاعبين والشخصيات</span>
          <div className="s-final-roster">
            {playersArr.map(p => {
              const variant = p.gameRole === 'mafiozo' ? 'mafiozo'
                            : p.gameRole === 'obvious_suspect' ? 'suspect'
                            : '';
              return (
                <div key={p.playerId} className={`s-final-player ${variant}`}>
                  <div className="nm">{p.username}</div>
                  <div className="ch">
                    {p.characterName}<span className="role"> — {p.storyRole}</span>
                  </div>
                  <div className="det">!!{p.suspiciousDetail}!!</div>
                  <div className="row">
                    <span className="role-tag">{p.roleLabelArabic || '—'}</span>
                    <span className="status">{p.survived ? '✓ نجا' : `✕ خرج في الجولة ${p.eliminatedRound || '?'}`}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* CLUE ANALYSIS ------------------------------------------------ */}
      {cluesArr.length > 0 && (
        <section className="s-final-section final-reveal-section">
          <span className="section-overline">Clue Analysis · قراءة الأدلة</span>
          <div className="s-final-clue-grid">
            {cluesArr.map(c => (
              <div key={c.index} className="s-final-clue">
                <div className="clue-head">
                  <span className="clue-num">الدليل {c.index + 1}</span>
                  <span className="clue-type">{c.typeLabel}</span>
                </div>
                <blockquote>"{c.text}"</blockquote>
                <span className="row-label">اللي شافتوه الساحة</span>
                <p className="surface">{c.surfaceMeaning}</p>
                <span className="row-label">الحقيقة</span>
                <p className="reality">{c.realMeaning}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* VOTING TIMELINE ---------------------------------------------- */}
      {Array.isArray(data.votingTimeline) && data.votingTimeline.length > 0 && (
        <section className="s-final-section final-reveal-section">
          <span className="section-overline">Vote History · سجل التصويت</span>
          <div className="s-final-timeline">
            {data.votingTimeline.map(r => {
              const cls = r.wasMafiozo ? 'caught' : r.eliminatedId ? 'elim' : '';
              return (
                <div key={r.round} className={`s-final-round ${cls}`}>
                  <div className="round-num">الجولة {r.round}</div>
                  <p className="round-summary">{r.summary}</p>
                  {r.tally && Object.keys(r.tally).length > 0 && (
                    <div className="round-tally">
                      {Object.entries(r.tally)
                        .sort((a, b) => b[1] - a[1])
                        .map(([k, v]) => `${k === 'skip' ? 'امتناع' : k} (${v})`)
                        .join(' · ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* DRAMATIC BEATS ----------------------------------------------- */}
      {Array.isArray(data.dramaticBeats) && data.dramaticBeats.length > 0 && (
        <section className="s-final-section final-reveal-section">
          <span className="section-overline">Key Moments · لحظات حاسمة</span>
          <ul className="s-final-beats">
            {data.dramaticBeats.map((beat, i) => (
              <li key={i} className="s-final-beat">
                <span className="marker">◆</span>{beat}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* BLIND-MODE CODA ---------------------------------------------- */}
      {data.roleRevealMode === 'blind' && (
        <section className="s-final-section final-reveal-section">
          <span className="section-overline">Blind Mode · طور عمياني</span>
          <div className="s-final-card danger-edge">
            <p>اللعبة كانت عمياني، والحقيقة كانت متدارية حتى عن أصحابها. كل لاعب كان شايف تفصيلته المريبة، لكن محدش كان ماسك الصورة كاملة.</p>
          </div>
        </section>
      )}

      {/* FINAL PARAGRAPH ---------------------------------------------- */}
      {data.finalParagraph && (
        <section className="s-final-section final-reveal-section">
          <div className={`s-final-closing ${closingCls}`}>
            <p>{data.finalParagraph}</p>
          </div>
        </section>
      )}

      {/* SHARE CARD --------------------------------------------------- */}
      <section className="s-final-section final-reveal-section">
        <span className="section-overline">Share · شارك الجلسة</span>
        <div className="s-final-share">
          <div className="s-final-share-card" id="final-share-card" aria-label="ملخص الجلسة جاهز للمشاركة">
            <div className="s-final-share-brand">
              <span className="s-final-share-mark" aria-hidden="true">▲</span>
              <span className="s-final-share-brand-text">الكبير · مافيوزو</span>
            </div>
            {data.winnerLabel && (
              <div className={`s-final-share-verdict ${headlineCls}`}>{data.winnerLabel}</div>
            )}
            {(data.caseSummary?.title || data.title) && (
              <div className="s-final-share-title">{data.caseSummary?.title || data.title}</div>
            )}
            <ul className="s-final-share-stats">
              {stats.players != null  && <li><b>{stats.players}</b><span>لاعبين</span></li>}
              {stats.clues != null    && <li><b>{stats.clues}</b><span>أدلة</span></li>}
              {stats.mafiozos != null && <li><b>{stats.mafiozos}</b><span>مافيوزو</span></li>}
              {stats.rounds != null   && <li><b>{stats.rounds}</b><span>جولات</span></li>}
            </ul>
            {mafiozosArr.length > 0 && (
              <div className="s-final-share-mafiozo">
                <span className="lbl">مافيوزو الجلسة</span>
                <span className="val">{mafiozosArr.map(m => m.username).filter(Boolean).join('، ')}</span>
              </div>
            )}
            {closingLine && <p className="s-final-share-closing">{closingLine}</p>}
          </div>
          <div className="s-final-share-actions">
            <button
              type="button"
              className="ak-btn ak-btn-primary"
              onClick={handleCopyShare}
              aria-live="polite"
            >
              {shareCopied ? 'تم النسخ ✓' : 'نسخ ملخص النتيجة'}
            </button>
            <p className="s-final-share-screenshot">
              التقط سكرينشوت للكارت من على الشاشة لو حابب تشاركه كصورة
              <span aria-hidden="true"> · </span>
              <span className="s-final-share-keys">Win+Shift+S / Cmd+Shift+4</span>
            </p>
            {shareError && (
              <p className="s-final-share-fallback">
                النسخ التلقائي اتمنع من المتصفح — انسخ الملخص يدويًا من المربع تحت.
              </p>
            )}
            <textarea
              ref={shareTextareaRef}
              className="s-final-share-textarea"
              readOnly
              value={shareSummary}
              rows={Math.min(8, Math.max(4, shareSummary.split('\n').length))}
              aria-label="ملخص النتيجة كنص قابل للنسخ"
            />
          </div>
        </div>
      </section>

      {/* CTAS --------------------------------------------------------- */}
      <div className="s-final-cta">
        <button className="ak-btn ak-btn-primary" onClick={onNewGame} style={{ minWidth: '240px' }}>
          {data.ctas?.newGame || 'ابدأ جلسة جديدة'}
        </button>
        <button className="ak-btn ak-btn-ghost" onClick={onBackToLobby} style={{ minWidth: '200px' }}>
          {data.ctas?.backToLobby || 'ارجع للساحة'}
        </button>
        {onViewReport && (
          <button className="ak-btn ak-btn-ghost" onClick={onViewReport} style={{ minWidth: '200px' }}>
            تقرير الجلسة
          </button>
        )}
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
  // Player-readiness during CLUE_REVEAL.
  const [readyProgress, setReadyProgress] = useState({ ready: 0, total: 0 });
  const [iAmReady, setIAmReady] = useState(false);
  const [readyError, setReadyError] = useState('');
  // Player-driven extension during VOTING.
  const [voteExt, setVoteExt] = useState({ requested: 0, total: 0, required: 0, activated: false, secondsAdded: 0 });
  const [iRequestedExt, setIRequestedExt] = useState(false);
  const [extError, setExtError] = useState('');
  const [extJustAddedAt, setExtJustAddedAt] = useState(0);
  const [eliminatedIds, setEliminatedIds] = useState([]);
  const [outcome, setOutcome] = useState(null);
  const [clueIndex, setClueIndex] = useState(0);
  const [totalClues, setTotalClues] = useState(3);
  const [hostError, setHostError] = useState('');     // Arabic error from rejected host action
  const [hostSuccess, setHostSuccess] = useState(''); // brief confirmation for host actions
  const [sessionEnded, setSessionEnded] = useState(false);
  const [finalReveal, setFinalReveal] = useState(null);
  // Optional AI polish lines (C2 / C3). All start null and remain so when
  // the AI fails or is slow — deterministic copy renders on its own.
  const [voteResultFlavor, setVoteResultFlavor] = useState(null);     // { round, line }
  const [clueTransitionFlavor, setClueTransitionFlavor] = useState(null); // { round, line }
  const [finalRevealAiPolish, setFinalRevealAiPolish] = useState(null);   // { heroSubtitle?, ... }
  // Connection: 'connected' | 'reconnecting' | 'disconnected' | 'recently_reconnected'
  const [connectionStatus, setConnectionStatus] = useState(socket.connected ? 'connected' : 'reconnecting');

  // Reset per-round transient state when we enter a new VOTING round.
  useEffect(() => {
    if (gameState === 'VOTING') {
      setMyVote(null);
      setVoteError('');
      setVoteResult(null);
      // Per-round vote-extension reset on the client. Server also resets
      // and broadcasts a fresh vote_extension_progress on phase enter.
      setIRequestedExt(false);
      setExtError('');
      setExtJustAddedAt(0);
      // Drop the previous round's vote-result flavor; the next vote_result
      // event will carry a fresh one (or none).
      setVoteResultFlavor(null);
    }
    if (gameState === 'CLUE_REVEAL') {
      // Fresh round of discussion — reset readiness on the client. Server
      // also resets and broadcasts a fresh ready_to_vote_progress.
      setIAmReady(false);
      setReadyError('');
      // Clue-transition flavor is per-round; reset on every new clue.
      setClueTransitionFlavor(null);
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
      if (data.finalReveal !== undefined) {
        setFinalReveal(data.finalReveal || null);
        // If the server already attached AI polish (later-joining client),
        // pick it up from the persistent state. The standalone event also
        // delivers it for in-flight clients.
        if (data.finalReveal && data.finalReveal.aiPolish && typeof data.finalReveal.aiPolish === 'object') {
          setFinalRevealAiPolish(data.finalReveal.aiPolish);
        }
      }
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
    // C2 / C3 optional flavor events. All idempotent and best-effort.
    const onVoteResultFlavor = (data) => {
      if (data && typeof data.line === 'string' && data.line.length > 0) {
        setVoteResultFlavor({ round: data.round || null, line: data.line });
      }
    };
    const onClueTransitionFlavor = (data) => {
      if (data && typeof data.line === 'string' && data.line.length > 0) {
        setClueTransitionFlavor({ round: data.round || null, line: data.line });
      }
    };
    const onFinalRevealPolish = (data) => {
      if (data && data.polish && typeof data.polish === 'object') {
        setFinalRevealAiPolish(data.polish);
      }
    };
    const onReadyProgress = (data) => {
      if (data && typeof data.ready === 'number' && typeof data.total === 'number') {
        setReadyProgress(data);
      }
    };
    const onReadyRejected = (data) => {
      setReadyError((data && data.message) || 'لا يمكنك إعلان الاستعداد للتصويت الآن.');
      setTimeout(() => setReadyError(''), 3500);
    };
    const onExtProgress = (data) => {
      if (!data) return;
      setVoteExt(data);
      if (data.activated) setExtJustAddedAt(Date.now());
    };
    const onExtRejected = (data) => {
      setExtError((data && data.message) || 'تعذّر طلب التمديد.');
      setTimeout(() => setExtError(''), 3500);
    };

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
    socket.on('ready_to_vote_progress', onReadyProgress);
    socket.on('ready_to_vote_rejected', onReadyRejected);
    socket.on('vote_extension_progress', onExtProgress);
    socket.on('vote_extension_rejected', onExtRejected);
    socket.on('vote_result_flavor', onVoteResultFlavor);
    socket.on('clue_transition_flavor', onClueTransitionFlavor);
    socket.on('final_reveal_polish', onFinalRevealPolish);

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
      socket.off('ready_to_vote_progress', onReadyProgress);
      socket.off('ready_to_vote_rejected', onReadyRejected);
      socket.off('vote_extension_progress', onExtProgress);
      socket.off('vote_extension_rejected', onExtRejected);
      socket.off('vote_result_flavor', onVoteResultFlavor);
      socket.off('clue_transition_flavor', onClueTransitionFlavor);
      socket.off('final_reveal_polish', onFinalRevealPolish);
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

  // Player-driven flow: declare readiness during CLUE_REVEAL.
  const handleReadyToVote = () => {
    if (iAmReady) return;
    setReadyError('');
    setIAmReady(true);                // optimistic; server will broadcast
    socket.emit('ready_to_vote', { roomId });
  };
  // Player-driven flow: ask for an extra 15s during VOTING.
  const handleRequestExtension = () => {
    if (iRequestedExt || voteExt.activated) return;
    setExtError('');
    setIRequestedExt(true);            // optimistic; server will broadcast
    socket.emit('request_vote_extension', { roomId });
  };

  // ----- recovery / loading ----------------------------------------------
  if (sessionEnded) {
    return (
      <>
        <ConnectionBanner status={connectionStatus} />
        <div className="container animate-fade-in" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
          <div className="card text-center max-w-md mx-auto" style={{ padding: '2.5rem' }}>
            <h2 className="cinematic-glow mb-3">المضيف أنهى الجلسة</h2>
            <p className="text-muted mb-6">يلا نبدأ غرفة جديدة؟</p>
            <button className="ak-btn ak-btn-primary" onClick={() => navigate('/lobby')}>ارجع للساحة</button>
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
            <h2 className="cinematic-glow mb-4">تعذر استعادة الغرفة</h2>
            <p className="text-muted mb-6">الغرفة انتهت أو غير موجودة. ارجع للساحة وابدأ غرفة جديدة.</p>
            <button className="ak-btn ak-btn-primary" onClick={() => navigate('/lobby')}>ارجع للساحة</button>
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
            <div className="ak-loading-dot pulse-animation" aria-hidden="true" />
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
            <div className="s-auth-error" style={{ marginTop: 'var(--ak-space-3)', maxWidth: '480px', marginInline: 'auto' }}>{hostError}</div>
          )}
        </div>
      ) : (
        // -------- Player view: cinematic role card ---------------------
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

                <p className="warning">{roleCard.warning || 'لا تكشف بطاقتك للاعبين التانيين.'}</p>
              </div>
            )}
          </div>
        </div>
      )}
      </>
    );
  }

  // ----- PUBLIC_CHARACTER_OVERVIEW: 10 s public summary -------------------
  // FixPack v2 / Commit 2: this screen renders for ALL connected clients
  // (host AND non-host). The phase auto-advances after 10s via the server
  // timer; the host's "skip" button is OPTIONAL and only shortens the wait.
  // Non-host clients NEVER need a host action to see this phase.
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
            <button
              className="ak-btn ak-btn-ghost"
              onClick={() => handleHostAction('skip_public_overview')}
              style={{ minWidth: '260px' }}
              title="اختياري — العرض ينتهي تلقائيًا بعد 10 ثوان"
            >
              تخطّي العرض (اختياري)
            </button>
            {hostError && (
              <div className="s-auth-error" style={{ marginTop: 'var(--ak-space-3)', maxWidth: '480px', marginInline: 'auto' }}>{hostError}</div>
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
            aiPolish={finalRevealAiPolish}
            fallbackOutcome={outcome}
            onNewGame={() => { setFinalReveal(null); setFinalRevealAiPolish(null); navigate('/lobby'); }}
            onBackToLobby={() => navigate('/lobby')}
            onViewReport={() => navigate('/report', { state: { gameId: roomId } })}
          />
        </div>
      </>
    );
  }

  // ----- main arena (CLUE_REVEAL / VOTING / VOTE_RESULT / legacy LOBBY/ARCHIVE_LOCKED)
  const phaseLabel =
    gameState === 'CLUE_REVEAL'   ? `Round ${Math.min(clueIndex + 1, totalClues)} · The Clue`
    : gameState === 'VOTING'      ? `Round ${Math.min(clueIndex + 1, totalClues)} · Vote`
    : gameState === 'VOTE_RESULT' ? `Round ${voteResult?.round || '-'} · Verdict`
    : gameState === 'LOBBY'       ? 'Setup'
    : 'Arena';
  const timerCls = timer <= 0 ? '' : timer <= 10 ? 'urgent' : timer <= 30 ? 'warn' : '';
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();

  return (
    <>
    <ConnectionBanner status={connectionStatus} />
    <div className="s-arena animate-fade-in">
      {/* Top bar — phase + timer */}
      <div className="s-arena-top">
        <div className="ph">{phaseLabel}</div>
        <div className={`timer ${timerCls}`}>00:{Math.max(0, timer).toString().padStart(2, '0')}</div>
      </div>

      <div className="s-arena-grid">
        {/* LEFT — phase content stage */}
        <div className="s-arena-stage">

          {gameState === 'LOBBY' && (
            <div style={{ textAlign: 'center' }}>
              <h2 className="ak-cinematic-glow">جاري تهيئة التحقيق</h2>
              <p style={{ color: 'var(--ak-text-muted)', marginTop: 'var(--ak-space-3)' }}>في انتظار باقي اللاعبين...</p>
            </div>
          )}

          {gameState === 'ARCHIVE_LOCKED' && (
            <div className="s-archive-locked animate-fade-in">
              <img
                src="/design/scene-archive-book.png"
                alt=""
                aria-hidden="true"
                className="s-archive-locked-book"
              />
              <span className="ak-overline">Protocol Zero · Sealed</span>
              <h2 className="s-archive-locked-title">الأرشيف مختوم</h2>
              <p style={{ color: 'var(--ak-text-muted)', marginBottom: 'var(--ak-space-4)' }}>
                تم تشفير الحقيقة. القصة ثابتة ولا مجال لتغييرها الآن.
              </p>
              <div style={{ background: 'var(--ak-crimson-bg-muted)', border: '1px solid var(--ak-border-red)', borderRadius: 'var(--ak-radius-md)', padding: 'var(--ak-space-3)', font: 'var(--ak-t-mono)', fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', wordBreak: 'break-all', direction: 'ltr', textAlign: 'left', marginBottom: 'var(--ak-space-4)' }}>
                PROTOCOL_ZERO_HASH:<br />{archiveBase64.slice(0, 200)}{archiveBase64.length > 200 ? '…' : ''}
              </div>
              <p style={{ color: 'var(--ak-gold)', font: 'var(--ak-t-h4)' }}>بانتظار نطق الدليل...</p>
            </div>
          )}

          {gameState === 'CLUE_REVEAL' && (() => {
            // Eliminated jurors are still voting participants in the next
            // round, so they may also press "ready". Only host is excluded.
            const canReady = !amIHost;
            return (
              <div className="s-clue animate-fade-in">
                <span className="ak-overline s-clue-overline">Clue {Math.min(clueIndex + 1, totalClues)} / {totalClues}</span>
                <h2 style={{ font: 'var(--ak-t-h2)', color: 'var(--ak-gold)', marginBottom: 'var(--ak-space-5)' }}>دليل من الكبير</h2>
                {clueTransitionFlavor && clueTransitionFlavor.line && (
                  <p className="s-clue-flavor" style={{
                    color: 'var(--ak-text-muted)',
                    font: 'var(--ak-t-caption)',
                    fontStyle: 'italic',
                    marginBottom: 'var(--ak-space-4)',
                    lineHeight: 1.7,
                  }}>{clueTransitionFlavor.line}</p>
                )}
                <div className="s-clue-card">
                  <span className="quote-mark" aria-hidden>"</span>
                  <blockquote>{currentClue || 'لا يوجد دليل متاح حالياً.'}</blockquote>
                </div>
                <p className="s-clue-instruction">تناقشوا فيما بينكم. الوقت يمر.</p>

                {/* Player-driven early end of discussion. Eligible players
                    declare readiness; when ALL are ready, server transitions
                    to VOTING. Host has a separate "start voting now" control. */}
                {canReady && (
                  <div className="s-ready-block" style={{ marginTop: 'var(--ak-space-5)', textAlign: 'center' }}>
                    {readyError && (
                      <div className="s-vote-banner error" style={{ marginBottom: 'var(--ak-space-3)' }}>{readyError}</div>
                    )}
                    {!iAmReady ? (
                      <button
                        className="ak-btn ak-btn-primary"
                        onClick={handleReadyToVote}
                        style={{ minWidth: '240px' }}
                      >
                        التصويت الآن
                      </button>
                    ) : (
                      <div className="s-vote-banner waiting">تم تسجيل استعدادك للتصويت</div>
                    )}
                    <div className="progress" style={{ marginTop: 'var(--ak-space-3)' }}>
                      جاهز للتصويت: {readyProgress.ready} من {readyProgress.total}
                    </div>
                  </div>
                )}
                {amIHost && (
                  <div className="progress" style={{ marginTop: 'var(--ak-space-4)', textAlign: 'center' }}>
                    جاهز للتصويت: {readyProgress.ready} من {readyProgress.total}
                  </div>
                )}
              </div>
            );
          })()}

          {gameState === 'VOTING' && (() => {
            const me = players.find(p => p.id === user?.id);
            const iAmEliminated = me ? !me.isAlive : false;
            // Jury rule: eliminated players keep voting; only host is barred.
            const canVote = !amIHost;
            // Eliminated players cannot be TARGETED — exclude them from the
            // candidate buttons. Voting eligibility is independent.
            const aliveNonHost = players.filter(p => !p.isHost && p.isAlive);
            const iHaveVoted = canVote && myVote !== null && myVote !== undefined;
            const everyoneVoted = votingProgress.total > 0 && votingProgress.voted >= votingProgress.total;
            return (
              <div className="s-vote animate-fade-in">
                <span className="ak-overline" style={{ color: 'var(--ak-crimson-stage)' }}>Vote · Round {Math.min(clueIndex + 1, totalClues)} / {totalClues}</span>
                <h1>حان وقت الحُكم</h1>
                <p style={{ color: 'var(--ak-text-muted)', marginBottom: 'var(--ak-space-2)' }}>مين المشتبه فيه النوبة دي؟</p>
                <div className="progress">صوّت {votingProgress.voted} من {votingProgress.total}</div>

                {voteError    && <div className="s-vote-banner error">{voteError}</div>}
                {amIHost      && <div className="s-vote-banner host">المضيف لا يصوّت. تابع تقدّم اللاعبين.</div>}
                {iAmEliminated && <div className="s-vote-banner elim">خرجت من دائرة الاتهام، لكن صوتك لسه مؤثر في الساحة.</div>}
                {iHaveVoted && !everyoneVoted && (
                  <div className="s-vote-banner waiting">صوّتت — مستني باقي اللاعبين ({votingProgress.total - votingProgress.voted} متبقي)</div>
                )}
                {extError && <div className="s-vote-banner error">{extError}</div>}
                {voteExt.activated && (Date.now() - extJustAddedAt) < 6000 && (
                  <div className="s-vote-banner waiting">تم تمديد التصويت 15 ثانية</div>
                )}
                {/* Player-driven 15s extension. Threshold ceil(70%) of voting
                    participants (eliminated jurors included); one extension
                    per round; only host excluded. */}
                {canVote && !voteExt.activated && (
                  <div className="s-ext-block" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--ak-space-2)', marginTop: 'var(--ak-space-3)' }}>
                    {!iRequestedExt ? (
                      <button
                        className="ak-btn ak-btn-host"
                        onClick={handleRequestExtension}
                        style={{ minWidth: '220px' }}
                      >
                        طلب 15 ثانية إضافية
                      </button>
                    ) : (
                      <div className="s-vote-banner waiting" style={{ margin: 0 }}>طلب التمديد متسجّل</div>
                    )}
                    <div className="progress">
                      طلبات التمديد: {voteExt.requested} من {voteExt.total} · المطلوب {voteExt.required}
                    </div>
                  </div>
                )}

                <div className="s-vote-grid">
                  {aliveNonHost.map(p => {
                    const selected = myVote === p.id;
                    return (
                      <button
                        key={p.id}
                        className={`s-vote-candidate${selected ? ' selected' : ''}`}
                        disabled={!canVote}
                        onClick={() => canVote && handleVote(p.id)}
                      >
                        <span className="s-vote-monogram" aria-hidden>{initial(p.username)}</span>
                        <span className="s-vote-name">{p.username}</span>
                      </button>
                    );
                  })}
                  {(() => {
                    const skipSelected = myVote === 'skip';
                    return (
                      <button
                        className={`s-vote-candidate skip-btn${skipSelected ? ' selected skip' : ''}`}
                        disabled={!canVote}
                        onClick={() => canVote && handleVote('skip')}
                      >
                        <span className="s-vote-name">امتناع عن التصويت</span>
                      </button>
                    );
                  })()}
                </div>
              </div>
            );
          })()}

          {gameState === 'VOTE_RESULT' && voteResult && (() => {
            // Resolve eliminated name: prefer broadcast field, fall back to a
            // local lookup, then to a safe Arabic placeholder. NEVER allow
            // the literal string "undefined" to reach the title.
            const elimById = voteResult.eliminatedId
              ? players.find(p => String(p.id) === String(voteResult.eliminatedId))
              : null;
            const resolvedElim = voteResult.eliminatedUsername
              || elimById?.username
              || (voteResult.eliminatedId ? 'مشتبه مجهول' : null);
            const isLastRound = voteResult.round >= totalClues;
            // E2: multi-Mafiozo aware title + subtitle. mafiozosRemaining
            // and totalMafiozos are safe public counters; identities of
            // remaining Mafiozos are NEVER on the wire.
            const remaining = Number.isFinite(voteResult.mafiozosRemaining) ? voteResult.mafiozosRemaining : 0;
            const total     = Number.isFinite(voteResult.totalMafiozos)     ? voteResult.totalMafiozos     : 1;
            const isMulti = total > 1;
            const titleText =
              voteResult.reason === 'majority'
                ? (voteResult.wasMafiozo
                    ? (remaining === 0
                        ? (isMulti ? 'اتقبض على آخر مافيوزو' : 'اتقبض على المافيوزو')
                        : 'اتقبض على مافيوزو، لكن الظل لسه له باقي')
                    : (resolvedElim ? `${resolvedElim} خرج من اللعبة` : 'مشتبه خرج من اللعبة'))
                : voteResult.reason === 'tie'    ? 'تعادل في التصويت — محدش خرج'
                : voteResult.reason === 'no-vote'? 'محدش صوّت — الجولة عدّت'
                : voteResult.reason === 'all-skip'? 'الكل امتنع عن التصويت'
                : '—';
            let subText;
            if (voteResult.reason === 'majority' && voteResult.wasMafiozo) {
              subText = remaining === 0
                ? 'الحقيقة اتكشفت. الأرشيف بيتفك دلوقتي.'
                : `لسه فيه ${remaining} مافيوزو في الساحة. الجولة الجاية هتقرّبكم من الحقيقة.`;
            } else if (voteResult.reason === 'majority' && !voteResult.wasMafiozo) {
              subText = isLastRound
                ? (isMulti ? 'الكشف ضاع — المافيوزو لسه وسطكم.' : 'الكشف ضاع — المافيوزو لسه وسطكم.')
                : 'الدليل الجاي هيقرّبكم من الحقيقة.';
            } else if (voteResult.reason === 'tie' || voteResult.reason === 'no-vote' || voteResult.reason === 'all-skip') {
              subText = isLastRound ? 'مفيش حسم في الجولة الأخيرة — المافيوزو لسه وسطكم.' : 'الجولة عدّت بدون حسم. الدليل الجاي طريقكم.';
            } else {
              subText = 'الجولة الجاية هتبدأ بدليل جديد.';
            }
            const accentClass = voteResult.reason === 'majority' && voteResult.wasMafiozo
              ? 'gold'
              : voteResult.reason === 'majority' ? 'crimson' : 'muted';
            return (
              <div className="s-result animate-fade-in">
                <span className="ak-overline">Verdict · Round {voteResult.round} / {totalClues}</span>
                <div className={`s-verdict-seal ${accentClass}`} aria-hidden>{voteResult.round}</div>
                <h1 className={accentClass}>{titleText}</h1>
                <p className="s-result-sub">{subText}</p>
                {voteResultFlavor && voteResultFlavor.line && (
                  <p className="s-result-flavor" style={{
                    color: 'var(--ak-text-muted)',
                    font: 'var(--ak-t-caption)',
                    fontStyle: 'italic',
                    marginTop: 'var(--ak-space-3)',
                    marginBottom: 'var(--ak-space-3)',
                    lineHeight: 1.7,
                    maxWidth: '38rem',
                  }}>{voteResultFlavor.line}</p>
                )}
                <div className="s-result-tally">
                  <div className="head">صوّت {voteResult.votedCount} من {voteResult.eligibleCount} — جولة {voteResult.round} من {totalClues}</div>
                  {voteResult.tally && Object.keys(voteResult.tally).length > 0 && (
                    <ul>
                      {Object.entries(voteResult.tally)
                        .sort((a, b) => b[1] - a[1])
                        .map(([targetId, count]) => {
                          const targetPlayer = players.find(p => String(p.id) === String(targetId));
                          const label = targetId === 'skip' ? 'امتناع' : (targetPlayer?.username || targetId);
                          return (
                            <li key={targetId}>
                              <span>{label}</span>
                              <span className="count">{count}</span>
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

        {/* RIGHT — host panel + player list */}
        <aside className="s-arena-aside">
          {amIHost && (
            <div className="s-host-panel">
              <div className="s-host-panel-head">
                <span className="label">Host Controls</span>
                <span className="icon" aria-hidden style={{ fontSize: '1.2rem', lineHeight: 1, color: 'var(--ak-gold)' }}>▲</span>
              </div>

              {hostError && <div className="s-host-toast err">{hostError}</div>}
              {hostSuccess && !hostError && <div className="s-host-toast ok">{hostSuccess}</div>}

              {(gameState === 'CLUE_REVEAL' || gameState === 'VOTING' || gameState === 'VOTE_RESULT' || gameState === 'PUBLIC_CHARACTER_OVERVIEW' || gameState === 'ROLE_REVEAL') && (
                <>
                  <div className="s-host-row">
                    <button className="ak-btn ak-btn-host" onClick={() => handleHostAction('pause')}>إيقاف</button>
                    <button className="ak-btn ak-btn-host" onClick={() => handleHostAction('resume')}>استكمال</button>
                  </div>
                  <div className="s-host-row full">
                    <button className="ak-btn ak-btn-host" onClick={() => handleHostAction('extend_timer')}>+30 ثانية</button>
                  </div>
                </>
              )}

              {gameState === 'CLUE_REVEAL' && (
                <div className="s-host-row full">
                  <button className="ak-btn ak-btn-primary" onClick={() => handleHostAction('start_voting_now')}>ابدأ التصويت دلوقتي</button>
                </div>
              )}
              {gameState === 'VOTING' && (
                <div className="s-host-row full">
                  <button className="ak-btn ak-btn-primary" onClick={() => handleHostAction('close_voting_now')}>اقفل التصويت دلوقتي</button>
                </div>
              )}
              {gameState === 'VOTE_RESULT' && !outcome && (
                <div className="s-host-row full">
                  <button className="ak-btn ak-btn-primary" onClick={() => handleHostAction('continue_next_round')}>الجولة الجاية</button>
                </div>
              )}

              <div className="s-host-divider" />

              <div className="s-host-row">
                <button className="ak-btn ak-btn-host" onClick={() => handleHostAction('trigger_final_reveal')}>اعرض الكشف النهائي</button>
                <button className="ak-btn ak-btn-host danger" onClick={confirmEndSession}>إنهاء الجلسة</button>
              </div>
            </div>
          )}

          <div className="s-player-list">
            {(() => {
              // Belt-and-suspenders: server already filters phantom rows in
              // buildPublicState, but if any record without id+username sneaks
              // through (older client cache, race), block it here too. PLAYERS
              // count must always match the visible rows.
              const safePlayers = players.filter(p => p && p.id && p.username);
              return (
                <>
                  <span className="head">Players · {safePlayers.length}</span>
                  {safePlayers.length === 0 && <p style={{ color: 'var(--ak-text-muted)', font: 'var(--ak-t-caption)' }}>جاري التحديث...</p>}
                  {safePlayers.map(p => {
                    const me = p.id === user?.id;
                    const cls = `s-player-row${p.isHost ? ' host' : ''}${!p.isAlive ? ' eliminated' : ''}`;
                    return (
                      <div key={p.id} className={cls}>
                        <div className="av">{initial(p.username)}</div>
                        <div className="nm">{p.username}{me ? ' (أنت)' : ''}</div>
                        <div className="tag">{p.isHost ? 'المضيف' : (!p.isAlive ? 'خرج' : 'مشتبه')}</div>
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>
        </aside>
      </div>
    </div>
    </>
  );
}
