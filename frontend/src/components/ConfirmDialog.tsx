import { useEffect, useRef, type ReactNode } from 'react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

/** Small confirmation modal. Escape or the backdrop cancels. `danger` (default) is red. */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = 'Keep it', tone = 'danger', busy, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus(); // safe default for a destructive action
  }, [open]);

  return (
    <Modal open={open} onClose={onCancel} busy={busy} role="alertdialog" labelledBy="confirm-title" className="max-w-sm rounded-xl p-6">
      <h2 id="confirm-title" className="text-base font-semibold text-gray-900">{title}</h2>
      <div className="mt-2 text-sm text-gray-600">{children}</div>
      <div className="mt-6 flex justify-end gap-2">
        <Button ref={cancelRef} variant="secondary" shape="rounded" onClick={onCancel} disabled={busy} className="font-normal">
          {cancelLabel}
        </Button>
        <Button variant={tone} shape="rounded" onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
