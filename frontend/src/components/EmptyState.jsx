import React from 'react';

/**
 * EmptyState — themed "no data" / "nothing here yet" surface.
 *
 * Use when a list, card, or section has no items to render. Replaces
 * ad-hoc bare paragraphs and one-off centered-text blocks with a
 * consistent visual treatment.
 *
 * Props:
 *   title       (string, required) — the headline copy.
 *   description (string, optional) — one-line elaboration under the title.
 *   icon        (string, optional) — Material Symbol name (decorative).
 *   cta         (ReactNode, optional) — typically an <AkButton>; renders below.
 *   tone        ('default' | 'compact') — compact = inline-card contexts;
 *                                          default = full sections.
 *
 * Not for:
 *   - <table> empty rows — those need <tr><td colSpan> shells.
 *   - Page-level "missing context" screens — those are page heroes, not
 *     list-empty states.
 */
export default function EmptyState({
  title,
  description,
  icon,
  cta,
  tone = 'default',
  className = '',
  ...rest
}) {
  const cls = `s-empty-state s-empty-state-${tone}${className ? ' ' + className : ''}`;
  return (
    <div className={cls} {...rest}>
      {icon && (
        <span className="s-empty-state-icon material-symbols-outlined" aria-hidden="true">
          {icon}
        </span>
      )}
      {title && <h3 className="s-empty-state-title">{title}</h3>}
      {description && <p className="s-empty-state-sub">{description}</p>}
      {cta && <div className="s-empty-state-cta">{cta}</div>}
    </div>
  );
}
