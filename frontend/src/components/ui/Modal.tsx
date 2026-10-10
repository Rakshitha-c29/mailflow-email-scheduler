import { useEffect, type ReactNode } from 'react';

/**
 * Centered modal with a dimmed backdrop. Escape and backdrop clicks close it, except while
 * `busy` (a request is in flight). `role="alertdialog"` for confirmations.
 */
export function Modal({ open, onClose, busy = false, labelledBy, role = 'dialog', className = '', children }: {
  open: boolean;
  onClose: () => void;
  busy?: boolean;
  labelledBy: string;
  role?: 'dialog' | 'alertdialog';
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={() => !busy && onClose()} />
      <div role={role} aria-modal="true" aria-labelledby={labelledBy} className={`relative w-full bg-white shadow-xl ${className}`}>
        {children}
      </div>
    </div>
  );
}
