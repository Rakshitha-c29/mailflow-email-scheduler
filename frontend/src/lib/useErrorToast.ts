import { useEffect, useRef } from 'react';
import { useToast } from '../components/Toast';

/**
 * Shows one error toast when `failing` turns true, and not again on every retry or 15 s
 * poll while it stays failing. It shows again only after a success followed by a new failure.
 */
export function useErrorToast(failing: boolean, message: string): void {
  const toast = useToast();
  const wasFailing = useRef(false);
  useEffect(() => {
    if (failing && !wasFailing.current) toast.error(message);
    wasFailing.current = failing;
  }, [failing, message, toast]);
}
