import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Variant = 'error' | 'success' | 'info';
interface Toast {
  id: number;
  message: string;
  variant: Variant;
}
interface ToastApi {
  error: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const DURATION_MS = 5000;

const styles: Record<Variant, string> = {
  error: 'border-red-200 bg-red-50 text-red-800',
  success: 'border-green-200 bg-brand-soft text-green-900',
  info: 'border-line bg-white text-ink',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((message: string, variant: Variant) => {
    const id = nextId.current++;
    // The same message twice in a row (double click) shows once.
    setToasts((t) => [...t.filter((x) => x.message !== message), { id, message, variant }].slice(-4));
    setTimeout(() => dismiss(id), DURATION_MS);
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    error: (m) => push(m, 'error'),
    success: (m) => push(m, 'success'),
    info: (m) => push(m, 'info'),
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // Bottom-right: page headers keep their primary actions top-right.
        aria-live="assertive"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.variant === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${styles[t.variant]}`}
          >
            <p className="flex-1">{t.message}</p>
            <button onClick={() => dismiss(t.id)} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
