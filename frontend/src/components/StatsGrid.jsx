import React from 'react';

/**
 * StatsGrid — renders the 10-field stats summary returned by
 * GET /api/stats/me. All fields tolerate undefined/null and fall back
 * to safe zero-defaults; winRate is rendered as an integer percent.
 */

const LABELS = {
  gamesPlayed:        'مباريات',
  wins:               'انتصارات',
  losses:             'هزائم',
  winRate:            'نسبة الانتصار',
  timesMafiozo:       'مرات المافيوزو',
  timesInnocent:      'مرات بريء',
  timesObviousSuspect:'مرات المشتبه الواضح',
  totalSurvivalRounds:'جولات النجاة',
  favoriteMode:       'الطور المفضل',
  lastPlayedAt:       'آخر لعبة',
};

const MODE_LABEL = {
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

function num(v) { return Number.isFinite(v) ? v : 0; }

export default function StatsGrid({ stats }) {
  const s = stats || {};
  const cells = [
    { key: 'gamesPlayed',         value: num(s.gamesPlayed) },
    { key: 'wins',                value: num(s.wins) },
    { key: 'losses',              value: num(s.losses) },
    { key: 'winRate',             value: `${num(s.winRate)}%` },
    { key: 'timesMafiozo',        value: num(s.timesMafiozo) },
    { key: 'timesInnocent',       value: num(s.timesInnocent) },
    { key: 'timesObviousSuspect', value: num(s.timesObviousSuspect) },
    { key: 'totalSurvivalRounds', value: num(s.totalSurvivalRounds) },
    { key: 'favoriteMode',        value: s.favoriteMode ? (MODE_LABEL[s.favoriteMode] || s.favoriteMode) : '—' },
    { key: 'lastPlayedAt',        value: formatDate(s.lastPlayedAt) },
  ];
  return (
    <div className="s-stats-grid">
      {cells.map(c => (
        <div key={c.key} className="s-stats-cell">
          <span className="s-stats-label">{LABELS[c.key]}</span>
          <span className="s-stats-value">{c.value}</span>
        </div>
      ))}
    </div>
  );
}
