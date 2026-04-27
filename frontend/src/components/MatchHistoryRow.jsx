import React from 'react';
import { Link } from 'react-router-dom';

/**
 * MatchHistoryRow — one entry in the per-user match history list.
 *
 * D3 ships a row with the noir summary; D4 wires the "فتح الأرشيف"
 * link to /archive/:gameId. The link is always rendered; the page
 * itself handles the gated 403 for non-participants (which should
 * never happen for a row sourced from /api/history/me).
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

export default function MatchHistoryRow({ game }) {
  if (!game || !game.id) return null;
  const winnerClass =
    game.wasWinner === true ? 'win'
    : game.wasWinner === false ? 'lose'
    : 'neutral';
  return (
    <article className={`s-history-row ${winnerClass}`}>
      <header className="s-history-head">
        <h3 className="s-history-title">{game.scenarioTitle || 'قضية بدون عنوان'}</h3>
        <span className="s-history-date">{formatDate(game.endedAt || game.createdAt)}</span>
      </header>
      <ul className="s-history-meta">
        <li><span>الطور</span><strong>{REVEAL_LABEL[game.revealMode] || game.revealMode || '—'}</strong></li>
        <li><span>المضيف</span><strong>{MODE_LABEL[game.hostMode] || game.hostMode || '—'}</strong></li>
        <li><span>النتيجة</span><strong>{OUTCOME_LABEL[game.outcome] || game.outcome || '—'}</strong></li>
        <li><span>دورك</span><strong>{ROLE_LABEL[game.role] || game.role || '—'}</strong></li>
        <li>
          <span>الشخصية</span>
          <strong>{game.storyCharacterName || '—'}{game.storyCharacterRole ? ` · ${game.storyCharacterRole}` : ''}</strong>
        </li>
        <li>
          <span>المصير</span>
          <strong>
            {game.eliminatedAtRound
              ? `خرجت في الجولة ${game.eliminatedAtRound}`
              : 'وصلت للنهاية'}
          </strong>
        </li>
      </ul>
      <footer className="s-history-foot">
        <Link to={`/archive/${encodeURIComponent(game.id)}`} className="ak-btn ak-btn-ghost s-history-archive-btn">
          فتح الأرشيف
        </Link>
      </footer>
    </article>
  );
}
