import React from 'react';

/**
 * AdminMetricCard — single big-number tile for the admin dashboard.
 *
 * Props:
 *   label    : Arabic short label
 *   value    : the number (or null/undefined while loading)
 *   sublabel : optional secondary text below the number
 *   tone     : 'gold' | 'crimson' | 'neutral' (defaults to neutral)
 *   loading  : show shimmer while waiting on /api/admin/*
 */
export default function AdminMetricCard({ label, value, sublabel, tone = 'neutral', loading = false }) {
  const toneClass =
    tone === 'gold'    ? 's-admin-card s-admin-card-gold'
    : tone === 'crimson' ? 's-admin-card s-admin-card-crimson'
    :                     's-admin-card';

  return (
    <div className={toneClass}>
      <div className="s-admin-card-label">{label}</div>
      {loading
        ? <div className="shimmer" style={{ height: '2.4rem', width: '60%', margin: '0.4rem 0' }} aria-hidden="true" />
        : <div className="s-admin-card-value">
            {value === null || value === undefined ? '—' : formatNumber(value)}
          </div>
      }
      {sublabel ? <div className="s-admin-card-sublabel">{sublabel}</div> : null}
    </div>
  );
}

function formatNumber(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '—';
    if (v >= 1000) {
      // Use western digits with thousand separators — works for AR direction too.
      return v.toLocaleString('en-US');
    }
    if (Math.abs(v) > 0 && Math.abs(v) < 1) {
      return v.toFixed(2);
    }
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return String(v);
}
