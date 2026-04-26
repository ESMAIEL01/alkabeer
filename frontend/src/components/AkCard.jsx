import React from 'react';

/**
 * Canonical card chrome. Surface / elevation by HEAT, not light, per
 * SKILL.md rule #2. Three variants:
 *
 *   tone="surface"  (default) — base card (`--ak-surface-1`)
 *   tone="elevated"           — hover/modal (`--ak-surface-2`)
 *   tone="danger"             — danger panel (`--ak-pair-panel-danger-*`)
 *   tone="success"            — success panel (`--ak-pair-panel-success-*`)
 *
 * `glow` opt-in: `"gold" | "crimson"` — applies the canonical halo. Use
 * sparingly; only one glow per screen per the design system.
 */
export default function AkCard({
  tone = 'surface',
  glow = null,
  as: Tag = 'div',
  className = '',
  style,
  children,
  ...rest
}) {
  const cls = `ak-card ak-card-${tone}${glow ? ' ak-card-glow-' + glow : ''}${className ? ' ' + className : ''}`;
  return (
    <Tag className={cls} style={style} {...rest}>
      {children}
    </Tag>
  );
}
