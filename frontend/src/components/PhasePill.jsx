import React from 'react';

/**
 * Phase pill — small uppercase Arabic badge that names the current phase
 * and optionally the round/clue counter. Lifted from the design system's
 * canonical phase header pattern (previews/04-components.html).
 *
 * Variants:
 *   tone="gold"   (default) — neutral phases (CLUE_REVEAL, OVERVIEW, etc.)
 *   tone="danger"            — pressure phases (VOTING)
 */
export default function PhasePill({ tone = 'gold', children }) {
  return (
    <span className={`phase-pill${tone === 'danger' ? ' danger' : ''}`}>
      {children}
    </span>
  );
}
