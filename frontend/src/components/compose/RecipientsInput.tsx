import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';

// Same pragmatic rule as the server (which re-validates everything).
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isValidEmail = (e: string) => e.length <= 254 && EMAIL_RE.test(e);

const SEPARATORS = /[\s,;]+/;
/** Collapsed view shows this many chips + "+N" (design "Compose", filled state). */
const COLLAPSED_CHIPS = 3;

/**
 * Recipients as chips: typing a separator, Enter, Tab, blur or pasting commits addresses.
 * Addresses are lowercased and de-duplicated; invalid ones stay visible (red) until fixed.
 */
export function RecipientsInput({ value, onChange, invalid, id }: {
  value: string[];
  onChange: (next: string[]) => void;
  invalid?: boolean;
  id?: string;
}) {
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const incoming = raw.split(SEPARATORS).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!incoming.length) return;
    const seen = new Set(value);
    const added = incoming.filter((e) => !seen.has(e) && seen.add(e));
    if (added.length) onChange([...value, ...added]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') && text.trim()) {
      e.preventDefault();
      commit(text);
      setText('');
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!SEPARATORS.test(pasted.trim())) return; // single address: let it land in the input
    e.preventDefault();
    commit(text + pasted);
    setText('');
  };

  const remove = (email: string) => onChange(value.filter((v) => v !== email));
  // Invalid addresses are always visible, so a problem can't hide inside "+N".
  const shown = expanded
    ? value
    : [...value.slice(0, COLLAPSED_CHIPS), ...value.slice(COLLAPSED_CHIPS).filter((v) => !isValidEmail(v))];
  const hidden = value.length - shown.length;

  return (
    <div className="min-w-0 flex-1 pl-2.5">
      <div className="flex flex-wrap items-center gap-1.5 py-1.5" onClick={() => inputRef.current?.focus()}>
        {shown.map((email) => {
          const ok = isValidEmail(email);
          return (
            <span
              key={email}
              className={`group relative inline-flex h-[26px] max-w-full items-center rounded-full border px-2.5 text-xs ${
                ok ? 'border-[#56c47f] bg-[#e6f7ed] text-gray-900' : 'border-red-300 bg-red-50 text-red-700'
              }`}
              title={ok ? email : `${email} is not a valid email address`}
            >
              <span className="truncate">{email}</span>
              {/* Hidden until hover/focus to keep the design's clean chips; Backspace also removes.
                  Overlaid (not inserted) so showing it never changes the chip's width: otherwise
                  the row re-wraps under the pointer and the chips jitter. */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); remove(email); }}
                aria-label={`Remove ${email}`}
                className={`absolute top-1/2 right-1 flex -translate-y-1/2 rounded-full p-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 ${
                  ok ? 'bg-[#e6f7ed] hover:bg-[#d4efdf]' : 'bg-red-50 hover:bg-red-100'
                }`}
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        {hidden > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
            aria-label={`Show ${hidden} more recipient${hidden === 1 ? '' : 's'}`}
            className="h-[26px] rounded-full border border-[#56c47f] bg-[#e6f7ed] px-2.5 text-xs text-gray-900 hover:bg-brand-soft-hover"
          >
            +{hidden.toLocaleString('en-US')}
          </button>
        )}
        {expanded && value.length > COLLAPSED_CHIPS && (
          <button type="button" onClick={(e) => { e.stopPropagation(); setExpanded(false); }} className="h-[26px] px-1 text-xs text-brand hover:underline">
            Show less
          </button>
        )}
        <input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="email"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => { commit(text); setText(''); }}
          placeholder={value.length ? '' : 'recipient@example.com'}
          aria-invalid={invalid || undefined}
          className="min-w-[180px] flex-1 bg-transparent py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400"
        />
      </div>
    </div>
  );
}
