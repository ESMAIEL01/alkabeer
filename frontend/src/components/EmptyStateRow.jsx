import React from 'react';

/**
 * EmptyStateRow — themed "no data" row for use inside <tbody>.
 *
 * Renders valid table markup: a single <tr> containing one <td colSpan>
 * with a centered EmptyState-style block inside. Use only inside a
 * <tbody>; placing it outside breaks HTML semantics.
 *
 * Props:
 *   colSpan     (number, required) — must match the parent table's column count.
 *   title       (string, required) — the headline copy.
 *   description (string, optional) — one-line elaboration under the title.
 *   icon        (string, optional) — Material Symbol name (decorative).
 *   tone        ('table', optional) — reserved for future tones; default "table".
 *
 * Accessibility:
 *   - Decorative icon is `aria-hidden="true"`.
 *   - Title and description are normal text — readable by screen readers.
 *   - Not an alert — neutral state, no role override.
 *
 * Not for:
 *   - Loading skeleton rows (use shimmer + empty <td> instead).
 *   - Error states with action recovery (those need an alert pattern).
 */
export default function EmptyStateRow({
  colSpan,
  title,
  description,
  icon,
  tone = 'table',
  className = '',
  ...rest
}) {
  const innerCls = `s-empty-state s-empty-state-${tone}`;
  return (
    <tr className={`s-empty-row${className ? ' ' + className : ''}`} {...rest}>
      <td colSpan={colSpan} className="s-empty-row-cell">
        <div className={innerCls}>
          {icon && (
            <span className="s-empty-state-icon material-symbols-outlined" aria-hidden="true">
              {icon}
            </span>
          )}
          {title && <h3 className="s-empty-state-title">{title}</h3>}
          {description && <p className="s-empty-state-sub">{description}</p>}
        </div>
      </td>
    </tr>
  );
}
