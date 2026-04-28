import React from 'react';

/**
 * AdminEventTable — render F1 analytics_events rows in a paginated table.
 *
 * The payload column is rendered as compact JSON. By the time a row reaches
 * this component:
 *   - F1 sanitizeEventPayload stripped dangerous keys at write-time.
 *   - F3 shapeAdminEvent ran dropForbiddenKeys on the read path defensively.
 * So the payload is ALWAYS safe to render verbatim. The component never
 * navigates to a URL field or executes any payload value — it just displays
 * pre-stringified short JSON.
 *
 * Props:
 *   events  : Array of { id, createdAt, eventType, userId, gameId, payload }
 *   loading : bool
 *   error   : string | null
 *   total, limit, offset, onChangePage(newOffset)
 */
export default function AdminEventTable({ events, loading, error, total, limit, offset, onChangePage }) {
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  return (
    <div className="s-admin-event-table-wrap">
      {error ? (
        <div className="s-auth-error" style={{ marginBottom: 'var(--ak-space-3)' }}>⚠ {error}</div>
      ) : null}
      <div className="s-admin-event-table-scroll">
        <table className="s-admin-event-table">
          <thead>
            <tr>
              <th>وقت</th>
              <th>الحدث</th>
              <th>المستخدم</th>
              <th>الغرفة</th>
              <th>الحمولة</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="5">
                  <div className="shimmer" style={{ height: '4rem' }} aria-hidden="true" />
                </td>
              </tr>
            ) : (events && events.length > 0) ? (
              events.map(ev => (
                <tr key={ev.id}>
                  <td className="s-admin-event-time">{formatShortTime(ev.createdAt)}</td>
                  <td><span className="s-admin-event-type">{ev.eventType}</span></td>
                  <td>{ev.userId !== null && ev.userId !== undefined ? ev.userId : '—'}</td>
                  <td>{ev.gameId || '—'}</td>
                  <td className="s-admin-event-payload">
                    {ev.payload && Object.keys(ev.payload).length > 0
                      ? <code>{JSON.stringify(ev.payload)}</code>
                      : <span style={{ color: 'var(--ak-text-muted)' }}>—</span>}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="5" style={{ textAlign: 'center', color: 'var(--ak-text-muted)', padding: 'var(--ak-space-4)' }}>
                  ما فيش أحداث في النطاق ده.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="s-admin-pagination">
        <button
          type="button"
          className="s-admin-pill"
          disabled={!hasPrev || loading}
          onClick={() => onChangePage(Math.max(0, offset - limit))}
        >
          السابق
        </button>
        <span>
          {offset + 1}–{Math.min(offset + limit, total)} من {total}
        </span>
        <button
          type="button"
          className="s-admin-pill"
          disabled={!hasNext || loading}
          onClick={() => onChangePage(offset + limit)}
        >
          التالي
        </button>
      </div>
    </div>
  );
}

function formatShortTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  // Render as 'YYYY-MM-DD HH:MM' in browser-local time.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
