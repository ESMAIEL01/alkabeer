import React, { useState } from 'react';

/**
 * AvatarMark — renders a player avatar with a deterministic noir fallback.
 *
 * Behavior:
 *   - If `src` is a non-empty string AND the image loads, show <img>.
 *   - Otherwise (no src OR image errors at runtime), show a circular
 *     initial badge built from the first character of `name`.
 *
 * Privacy:
 *   - `src` is rendered via <img src> only — no inline scripts, no
 *     dangerouslySetInnerHTML. The frontend already restricts avatarUrl
 *     to https:// at the validator boundary.
 */
export default function AvatarMark({ src, name, size = 96, className = '' }) {
  const [errored, setErrored] = useState(false);
  const trimmed = typeof src === 'string' ? src.trim() : '';
  const showImg = trimmed.length > 0 && !errored;
  const initial = (typeof name === 'string' && name.trim())
    ? name.trim().charAt(0).toUpperCase()
    : '?';

  const dim = `${size}px`;
  const wrapStyle = {
    width: dim,
    height: dim,
    minWidth: dim,
    borderRadius: '50%',
    overflow: 'hidden',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, var(--ak-bg-stage), var(--ak-surface-1))',
    border: '1px solid var(--ak-gold-soft)',
    boxShadow: 'inset 0 0 24px rgba(0,0,0,0.6)',
    color: 'var(--ak-gold)',
    fontFamily: 'var(--ak-font-display, inherit)',
    fontWeight: 700,
    fontSize: `${Math.max(18, Math.floor(size * 0.42))}px`,
    letterSpacing: '0.5px',
  };

  if (showImg) {
    return (
      <span className={`ak-avatar ${className}`} style={wrapStyle}>
        <img
          src={trimmed}
          alt=""
          onError={() => setErrored(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      </span>
    );
  }

  return (
    <span className={`ak-avatar ${className}`} style={wrapStyle} aria-hidden>
      {initial}
    </span>
  );
}
