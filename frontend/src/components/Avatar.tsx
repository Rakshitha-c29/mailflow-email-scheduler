import { useState } from 'react';

/**
 * Photo when available, otherwise initials. `tone="solid"` is the green sender avatar
 * from the email-detail design; `soft` is the signed-in user's.
 */
export function Avatar({ name, url = null, size = 30, tone = 'soft' }: {
  name: string;
  url?: string | null;
  size?: number;
  tone?: 'soft' | 'solid';
}) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (url && !broken) {
    return <img src={url} alt="" style={style} referrerPolicy="no-referrer" onError={() => setBroken(true)} className="shrink-0 rounded-full object-cover" />;
  }
  const initials = tone === 'solid'
    ? name.trim().charAt(0).toUpperCase()
    : name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span
      style={{ ...style, fontSize: Math.round(size * 0.4) }}
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${
        tone === 'solid' ? 'bg-green-500 text-white' : 'bg-brand-soft text-brand'
      }`}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
