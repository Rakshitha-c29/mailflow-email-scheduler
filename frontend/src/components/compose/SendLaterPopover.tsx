import { useEffect, useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { formatFull } from '../../lib/format';
import { Button } from '../ui/Button';

/** `YYYY-MM-DDTHH:mm` in local time, for <input type="datetime-local">. */
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function tomorrowAt(h?: number, m = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (h === undefined) d.setSeconds(0, 0); // "Tomorrow": same time tomorrow
  else d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Design "Send Later": pick a date & time or a preset; Done applies, Cancel discards.
 * Only future times are accepted.
 */
export function SendLaterPopover({ value, onApply, onClose }: {
  value: Date | null;
  /** `null` = no scheduled time (send immediately). */
  onApply: (d: Date | null) => void;
  onClose: () => void;
}) {
  const presets = useMemo(() => [
    { label: 'Tomorrow', date: tomorrowAt() },
    { label: 'Tomorrow, 10:00 AM', date: tomorrowAt(10) },
    { label: 'Tomorrow, 11:00 AM', date: tomorrowAt(11) },
    { label: 'Tomorrow, 3:00 PM', date: tomorrowAt(15) },
  ], []);
  const [pending, setPending] = useState<Date | null>(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const done = () => {
    // Clearing the field and pressing Done goes back to sending immediately.
    if (pending && pending.getTime() <= Date.now()) return setError('Pick a time in the future');
    onApply(pending);
  };

  return (
    <div role="dialog" aria-label="Send later" className="absolute top-full right-0 z-30 mt-7 flex min-h-[365px] w-80 flex-col rounded-lg border border-line bg-white p-4 shadow-lg">
      <p className="text-[15px] font-medium text-gray-900">Send Later</p>

      <label className="relative mt-4 flex items-center border-b border-gray-200 pb-1.5 focus-within:border-brand">
        <span className="sr-only">Pick date &amp; time</span>
        <input
          type="datetime-local"
          value={pending ? toLocalInput(pending) : ''}
          min={toLocalInput(new Date())}
          onChange={(e) => { setError(null); setPending(e.target.value ? new Date(e.target.value) : null); }}
          className={`peer w-full bg-transparent text-xs outline-none [&::-webkit-calendar-picker-indicator]:opacity-0 ${pending ? 'text-gray-900' : 'text-transparent'}`}
        />
        {!pending && <span className="pointer-events-none absolute left-0 text-xs text-gray-400">Pick date &amp; time</span>}
        <CalendarDays className="pointer-events-none absolute right-0 size-4 text-gray-400" aria-hidden="true" />
      </label>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      <ul className="-mx-2 mt-3 space-y-0.5">
        {presets.map((p) => {
          const active = pending?.getTime() === p.date.getTime();
          return (
            <li key={p.label}>
              <button
                type="button"
                onClick={() => { setError(null); setPending(p.date); }}
                aria-pressed={active}
                title={formatFull(p.date.toISOString())}
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${active ? 'bg-brand-soft font-medium text-gray-900' : 'text-gray-600 hover:bg-field'}`}
              >
                {p.label}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto flex items-center justify-end gap-3 pt-5">
        <button type="button" onClick={onClose} className="px-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
        <Button size="sm" className="px-5" onClick={done}>Done</Button>
      </div>
    </div>
  );
}
