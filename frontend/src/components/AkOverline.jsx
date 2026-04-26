import React from 'react';

/**
 * The cinematic Latin overline — uppercase Space Grotesk, gold, heavily
 * tracked. Used above headlines to set tone. Always LTR even inside RTL
 * content (per SKILL.md §3 and the .ak-overline rule in the token CSS).
 */
export default function AkOverline({ children, className = '', ...rest }) {
  return (
    <span className={`ak-overline${className ? ' ' + className : ''}`} {...rest}>
      {children}
    </span>
  );
}
