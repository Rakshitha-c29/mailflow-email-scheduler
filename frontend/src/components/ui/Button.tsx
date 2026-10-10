import type { ComponentProps } from 'react';

type Variant = 'outline' | 'primary' | 'secondary' | 'danger';
type Size = 'sm' | 'md' | 'header';

const VARIANTS: Record<Variant, string> = {
  outline: 'border border-brand bg-white text-brand hover:bg-brand-soft', // the designs' green pill
  primary: 'bg-brand text-white hover:bg-brand-hover',
  secondary: 'border border-line bg-white text-gray-700 hover:bg-field',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-4',
  md: 'h-9 px-5',
  header: 'h-[34px] min-w-[100px] px-5', // Compose "Send" in the page header
};

/** Text button. `shape="pill"` matches the designs' green pill buttons; dialogs use `rounded`. */
export function Button({ variant = 'outline', size = 'md', shape = 'pill', loading = false, className = '', children, ...rest }:
  ComponentProps<'button'> & { variant?: Variant; size?: Size; shape?: 'pill' | 'rounded'; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center gap-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60 ${
        shape === 'pill' ? 'rounded-full' : 'rounded-lg'} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    >
      {loading && <span className="size-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" aria-hidden="true" />}
      {children}
    </button>
  );
}
