import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AuthCard, SubmitButton, TextField } from '../components/AuthCard';
import { useToast } from '../components/Toast';
import { useLogin } from '../lib/auth';
import { useOAuthErrorToast } from '../lib/useOAuthErrorToast';
import { describeError, mergeErrors, validateEmail, type FieldErrors } from '../lib/validation';

type Field = 'email' | 'password';
const FIELDS = ['email', 'password'] as const;

function validate(v: Record<Field, string>): FieldErrors<Field> {
  return {
    email: validateEmail(v.email),
    password: v.password ? undefined : 'Password is required', // no strength rules on login
  };
}

export function LoginPage() {
  useOAuthErrorToast();
  const toast = useToast();
  const login = useLogin();
  const [values, setValues] = useState<Record<Field, string>>({ email: '', password: '' });
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors<Field>>({});

  // Errors appear after the first submit, then update live as the user types.
  const errors: FieldErrors<Field> = submitted ? mergeErrors(validate(values), serverErrors) : {};

  const set = (f: Field) => (e: ChangeEvent<HTMLInputElement>) => {
    setValues((v) => ({ ...v, [f]: e.target.value }));
    setServerErrors((s) => ({ ...s, [f]: undefined }));
  };

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setServerErrors({});
    if (Object.values(validate(values)).some(Boolean)) return;
    login.mutate(values, {
      onError: (err) => {
        const { fieldErrors, message } = describeError(err, FIELDS);
        setServerErrors(fieldErrors);
        if (message) toast.error(message);
      },
    });
  }

  return (
    <AuthCard
      title="Login"
      googleLabel="Login with Google"
      footer={<>Don’t have an account? <Link to="/signup" className="font-medium text-brand hover:underline">Sign up</Link></>}
    >
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <TextField label="Email ID" name="email" type="email" autoComplete="email"
          value={values.email} onChange={set('email')} error={errors.email} />
        <TextField label="Password" name="password" type="password" autoComplete="current-password"
          value={values.password} onChange={set('password')} error={errors.password} />
        <SubmitButton loading={login.isPending} loadingText="Logging in…">Login</SubmitButton>
      </form>
    </AuthCard>
  );
}
