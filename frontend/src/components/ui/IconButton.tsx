import type { ComponentProps, ReactNode } from 'react';

type Tone = 'muted' | 'strong' | 'brand' | 'amber';
const TONES: Record<Tone, string> = {
  muted: 'text-gray-400 hover:text-gray-600',
  strong: 'text-gray-700 hover:text-gray-900',
  brand: 'text-brand',
  amber: 'text-amber-400 hover:text-amber-500',
};

/**
 * Round icon-only button (headers, toolbars). `label` is required: it becomes the
 * accessible name and the tooltip. Exactly one colour set per button (see `tone`).
 */
export function IconButton({ label, tone = 'muted', size = 'sm', className = '', children, ...rest }:
  Omit<ComponentProps<'button'>, 'aria-label'> & { label: string; tone?: Tone; size?: 'sm' | 'md'; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={rest.title ?? label}
      {...rest}
      className={`relative flex shrink-0 items-center justify-center rounded-full hover:bg-field focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        size === 'sm' ? 'size-8' : 'size-9'} ${TONES[tone]} ${className}`}
    >
      {children}
    </button>
  );
}
