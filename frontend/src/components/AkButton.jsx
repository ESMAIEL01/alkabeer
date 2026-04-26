import React from 'react';

/**
 * Canonical Mafiozo button. Three styles map to the design system roles:
 *   - variant="primary"  → crimson CTA (`--ak-crimson-action`)
 *   - variant="gold"     → gold CTA, the "begin / continue" voice
 *   - variant="ghost"    → outlined gold-stroke ghost button
 *
 * No emoji in product UI per SKILL.md voice rules. Accept icon prop for the
 * occasional Material Symbol if needed (callers pass the symbol name string).
 */
export default function AkButton({
  variant = 'primary',
  type = 'button',
  icon,
  iconLeading = false,
  className = '',
  children,
  ...rest
}) {
  const cls = `ak-btn ak-btn-${variant}${className ? ' ' + className : ''}`;
  return (
    <button type={type} className={cls} {...rest}>
      {iconLeading && icon && (
        <span className="material-symbols-outlined" aria-hidden>{icon}</span>
      )}
      <span>{children}</span>
      {!iconLeading && icon && (
        <span className="material-symbols-outlined" aria-hidden>{icon}</span>
      )}
    </button>
  );
}
