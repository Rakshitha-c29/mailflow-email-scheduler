import type { InputHTMLAttributes, ReactNode } from 'react';
import { GoogleIcon } from './GoogleIcon';
import { GOOGLE_LOGIN_URL } from '../lib/auth';

/** Shared layout of the Login and Sign up screens (design: "Login Screen"). */
export function AuthCard({ title, googleLabel, children, footer }: {
  title: string;
  googleLabel: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-white px-4 py-12">
      <div className="w-full max-w-[488px] rounded-xl border border-line bg-white px-6 py-10 sm:px-14">
        <h1 className="text-center text-[32px] font-semibold tracking-tight text-ink">{title}</h1>

        <a
          href={GOOGLE_LOGIN_URL}
          className="mt-7 flex h-12 w-full items-center justify-center gap-2.5 rounded-lg bg-brand-soft text-sm font-medium text-ink transition-colors hover:bg-brand-soft-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <GoogleIcon />
          {googleLabel}
        </a>

        <div className="my-6 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          <span className="text-xs tracking-wide text-faint">or sign up through email</span>
          <span className="h-px flex-1 bg-line" />
        </div>

        {children}
      </div>
      <p className="mt-6 text-sm text-muted">{footer}</p>
    </main>
  );
}

export function TextField({ label, error, hint, ...input }: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
}) {
  const id = `f-${input.name}`;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="sr-only">{label}</label>
      <input
        id={id}
        placeholder={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`h-14 w-full rounded-lg bg-field px-5 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-brand ${
          error ? 'outline-2 outline-red-400' : ''
        }`}
        {...input}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 px-1 text-xs text-red-600">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 px-1 text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function SubmitButton({ loading, children, loadingText }: {
  loading: boolean;
  children: ReactNode;
  loadingText: string;
}) {
  return (
    <button
      type="submit"
      disabled={loading}
      aria-busy={loading}
      className="mt-7 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-70"
    >
      {loading && <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />}
      {loading ? loadingText : children}
    </button>
  );
}
