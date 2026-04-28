import React, { useMemo } from 'react';

/**
 * AdminTimeRangePicker — quick presets + manual ISO date inputs.
 *
 * Presets jump to a [from, to] pair where both are ISO-Z timestamps.
 * Manual inputs accept any string Date.parse can read; the parent
 * component normalizes via the same parseDateRange the API uses.
 *
 * Props:
 *   value    : { from, to } (ISO strings or undefined)
 *   onChange : (range: {from, to}) => void
 */
export default function AdminTimeRangePicker({ value, onChange }) {
  const presets = useMemo(() => {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const make = (days) => ({
      from: new Date(now.getTime() - days * day).toISOString(),
      to: now.toISOString(),
    });
    return [
      { label: '24 ساعة', range: make(1) },
      { label: '7 أيام', range: make(7) },
      { label: '30 يوم', range: make(30) },
      { label: '90 يوم', range: make(90) },
    ];
  }, []);

  const fromInput = value && value.from ? value.from.slice(0, 10) : '';
  const toInput   = value && value.to   ? value.to.slice(0, 10)   : '';

  const setManual = (key, val) => {
    if (!val) {
      onChange({ ...(value || {}), [key]: undefined });
      return;
    }
    const t = Date.parse(val);
    if (!Number.isFinite(t)) return;
    onChange({ ...(value || {}), [key]: new Date(t).toISOString() });
  };

  return (
    <div className="s-admin-rangepicker">
      <div className="s-admin-rangepicker-presets">
        {presets.map(p => (
          <button
            type="button"
            key={p.label}
            className="s-admin-pill"
            onClick={() => onChange(p.range)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="s-admin-rangepicker-inputs">
        <label className="s-admin-rangepicker-field">
          <span>من</span>
          <input
            type="date"
            value={fromInput}
            onChange={(e) => setManual('from', e.target.value)}
          />
        </label>
        <label className="s-admin-rangepicker-field">
          <span>إلى</span>
          <input
            type="date"
            value={toInput}
            onChange={(e) => setManual('to', e.target.value)}
          />
        </label>
      </div>
    </div>
  );
}
