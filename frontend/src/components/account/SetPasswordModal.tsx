import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { SubmitButton, TextField } from '../AuthCard';
import { Modal } from '../ui/Modal';
import { IconButton } from '../ui/IconButton';
import { GoogleIcon } from '../GoogleIcon';
import { useToast } from '../Toast';
import { ApiError } from '../../lib/api';
import { GOOGLE_LOGIN_URL } from '../../lib/auth';
import { useAccount, useSetPassword } from '../../lib/account';
import { PASSWORD_MIN, validateNewPassword, type FieldErrors } from '../../lib/validation';

type Field = 'current' | 'password' | 'confirm';

/**
 * "Set password" (Google-only account) / "Change password" (has one), styled like the
 * Login card. Uses POST /api/auth/password; the server signs out other devices.
 */
export function SetPasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const account = useAccount(open);
  const setPassword = useSetPassword();
  const [values, setValues] = useState<Record<Field, string>>({ current: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<FieldErrors<Field>>({});
  const [reauth, setReauth] = useState(false);
  const hasPassword = account.data?.hasPassword ?? false;
  // Which form to show (set vs change) depends on the account: never guess it.
  const accountFailed = account.isError && !account.data;

  const busy = setPassword.isPending;

  // Fresh form each time it opens.
  useEffect(() => {
    if (!open) return;
    setValues({ current: '', password: '', confirm: '' });
    setErrors({});
    setReauth(false);
  }, [open]);

  if (!open) return null;

  const set = (f: Field) => (e: ChangeEvent<HTMLInputElement>) => {
    setValues((v) => ({ ...v, [f]: e.target.value }));
    setErrors((x) => ({ ...x, [f]: undefined }));
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: FieldErrors<Field> = {
      current: hasPassword && !values.current ? 'Current password is required' : undefined,
      password: validateNewPassword(values.password),
      confirm: values.confirm !== values.password ? 'Passwords don’t match' : undefined,
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setPassword.mutate(
      { password: values.password, ...(hasPassword ? { currentPassword: values.current } : {}) },
      {
        onSuccess: () => {
          toast.success(hasPassword
            ? 'Password changed. Your other devices were signed out.'
            : 'Password set. You can now also sign in with your email and password.');
          onClose();
        },
        onError: (err) => {
          if (!(err instanceof ApiError)) return toast.error('Can’t reach the server. Please try again.');
          if (err.code === 'REAUTH_REQUIRED') return setReauth(true);
          if (err.code === 'INVALID_CREDENTIALS') return setErrors({ current: err.message });
          if (err.code === 'VALIDATION_ERROR') return setErrors({ password: err.message });
          toast.error(err.message);
        },
      },
    );
  }

  const title = !account.data ? 'Password' : hasPassword ? 'Change password' : 'Set password';
  return (
    // Escape / backdrop close it, but never mid-save (Modal's busy).
    <Modal open={open} onClose={onClose} busy={busy} labelledBy="pw-title" className="max-w-[440px] rounded-xl border border-line px-6 py-8 sm:px-10">
      <IconButton label="Close" onClick={onClose} className="absolute top-2 right-2">
        <X className="size-4" />
      </IconButton>
      <h2 id="pw-title" className="text-center text-2xl font-semibold tracking-tight text-ink">{title}</h2>
      <p className="mt-2 text-center text-sm text-muted">
        {account.isPending
          ? '…'
          : accountFailed
            ? 'Your account details didn’t load.'
          : hasPassword
            ? 'Your other devices will be signed out.'
            : `Sign in with ${account.data?.email ?? 'your email'} and a password, in addition to Google.`}
      </p>

      {accountFailed ? (
        <div className="mt-6 rounded-lg bg-red-50 p-4 text-sm text-red-800" role="alert">
          <p>Couldn’t load your account details, so the password form can’t be shown yet.</p>
          <button type="button" onClick={() => void account.refetch()} disabled={account.isFetching}
            className="mt-3 font-medium text-brand hover:underline disabled:opacity-60">
            {account.isFetching ? 'Retrying…' : 'Try again'}
          </button>
        </div>
      ) : account.isPending ? (
        <p className="mt-6 text-center text-sm text-muted" role="status">Loading your account…</p>
      ) : reauth ? (
        <div className="mt-6 rounded-lg bg-amber-50 p-4 text-sm text-amber-900" role="alert">
          <p className="flex gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            For your security, please sign in with Google again, then set your password within 15 minutes.
          </p>
          <a
            href={GOOGLE_LOGIN_URL}
            className="mt-4 flex h-11 w-full items-center justify-center gap-2.5 rounded-lg bg-brand-soft text-sm font-medium text-ink hover:bg-brand-soft-hover"
          >
            <GoogleIcon />
            Sign in with Google
          </a>
        </div>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={submit} noValidate>
          {hasPassword && (
            <TextField label="Current password" name="current-password" type="password" autoComplete="current-password"
              value={values.current} onChange={set('current')} error={errors.current} autoFocus />
          )}
          <TextField label="New password" name="new-password" type="password" autoComplete="new-password"
            value={values.password} onChange={set('password')} error={errors.password}
            hint={`At least ${PASSWORD_MIN} characters`} autoFocus={!hasPassword} />
          <TextField label="Confirm new password" name="confirm-password" type="password" autoComplete="new-password"
            value={values.confirm} onChange={set('confirm')} error={errors.confirm} />
          <SubmitButton loading={setPassword.isPending} loadingText="Saving…">{title}</SubmitButton>
        </form>
      )}
    </Modal>
  );
}
