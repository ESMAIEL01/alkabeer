import React from 'react';

/**
 * Brand mark — the AlKabeer wordmark/sigil composition used in the topnav,
 * Auth screen, and Lobby header. Pulls from /public/design which is shipped
 * by Vite as static assets.
 *
 * variant="full"     → sigil + wordmark side-by-side (default)
 * variant="sigil"    → sigil only
 * variant="wordmark" → wordmark only
 */
export default function AkBrandMark({ variant = 'full', size = 28, className = '' }) {
  const wrap = `ak-brandmark${className ? ' ' + className : ''}`;
  if (variant === 'sigil') {
    return (
      <span className={wrap}>
        <img src="/design/logo-sigil.svg" alt="" height={size} />
      </span>
    );
  }
  if (variant === 'wordmark') {
    return (
      <span className={wrap}>
        <img src="/design/logo-wordmark.svg" alt="AlKabeer" height={size} />
      </span>
    );
  }
  return (
    <span className={wrap}>
      <img src="/design/logo-sigil.svg" alt="" height={size} />
      <img src="/design/logo-wordmark.svg" alt="AlKabeer" height={size} />
    </span>
  );
}
