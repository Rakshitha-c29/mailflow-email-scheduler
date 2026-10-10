import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AuthCard, SubmitButton, TextField } from '../components/AuthCard';
import { useToast } from '../components/Toast';
import { useSignup } from '../lib/auth';
import { useOAuthErrorToast } from '../lib/useOAuthErrorToast';
import {
  describeError, mergeErrors, PASSWORD_MIN, validateEmail, validateName, validateNewPassword, type FieldErrors,
} from '../lib/validation';

type Field = 'name' | 'email' | 'password';
const FIELDS = ['name', 'email', 'password'] as const;

function validate(v: Record<Field, string>): FieldErrors<Field> {
  return { name: validateName(v.name), email: validateEmail(v.email), password: validateNewPassword(v.password) };
}

export function SignupPage() {
  useOAuthErrorToast();
  const toast = useToast();
  const signup = useSignup();
  const [values, setValues] = useState<Record<Field, string>>({ name: '', email: '', password: '' });
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors<Field>>({});

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
    signup.mutate(values, {
      onError: (err) => {
        const { fieldErrors, message } = describeError(err, FIELDS);
        setServerErrors(fieldErrors);
        if (message) toast.error(message);
      },
    });
  }

  return (
    <AuthCard
      title="Sign up"
      googleLabel="Sign up with Google"
      footer={<>Already have an account? <Link to="/login" className="font-medium text-brand hover:underline">Login</Link></>}
    >
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <TextField label="Name" name="name" autoComplete="name"
          value={values.name} onChange={set('name')} error={errors.name} />
        <TextField label="Email ID" name="email" type="email" autoComplete="email"
          value={values.email} onChange={set('email')} error={errors.email} />
        <TextField label="Password" name="password" type="password" autoComplete="new-password"
          value={values.password} onChange={set('password')} error={errors.password}
          hint={`At least ${PASSWORD_MIN} characters`} />
        <SubmitButton loading={signup.isPending} loadingText="Creating account…">Sign up</SubmitButton>
      </form>
    </AuthCard>
  );
}
