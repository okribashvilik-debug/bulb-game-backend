import { useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * Shared shell for the plain informational modals (How to Play, Game
 * Policy). Unlike DecisionModal — which is game-state-driven and has no
 * overlay — these are user-opened dialogs: dimmed overlay, ✕ button,
 * overlay click and Escape both close.
 */
export function InfoModal({
  open,
  onClose,
  ariaLabel,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="info-modal__overlay" onClick={onClose}>
      <div
        className="info-modal"
        role="dialog"
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="info-modal__header">
          <span className="info-modal__title">{title}</span>
          <button className="info-modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="info-modal__body">{children}</div>
      </div>
    </div>
  );
}
