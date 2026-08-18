import { useEffect, useState, type ReactNode } from 'react';

interface ToastItem {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

let toastListeners: ((toast: ToastItem) => void)[] = [];

export function toast(message: string, type: ToastItem['type'] = 'info') {
  const item: ToastItem = { id: `toast_${Date.now()}`, message, type };
  toastListeners.forEach((l) => l(item));
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener = (toast: ToastItem) => {
      setToasts((prev) => [...prev, toast]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, 3000);
    };
    toastListeners.push(listener);
    return () => {
      toastListeners = toastListeners.filter((l) => l !== listener);
    };
  }, []);

  const colors: Record<ToastItem['type'], string> = {
    success: 'border-success/30 bg-success/10 text-success',
    error: 'border-error/30 bg-error/10 text-error',
    info: 'border-primary/30 bg-primary/10 text-primary',
  };

  return (
    <div className="fixed bottom-8 right-4 z-[200] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`glass-elevated rounded-lg px-4 py-2.5 text-sm border ${colors[t.type]} animate-slide-up`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: { label: string; onClick: () => void; danger?: boolean }[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener('click', handler);
    window.addEventListener('contextmenu', handler);
    return () => {
      window.removeEventListener('click', handler);
      window.removeEventListener('contextmenu', handler);
    };
  }, [onClose]);

  return (
    <div
      className="fixed z-[300] glass-elevated rounded-lg py-1 min-w-[160px]"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => {
            item.onClick();
            onClose();
          }}
          className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors ${
            item.danger ? 'text-error' : 'text-on-surface-variant hover:text-on-surface'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  message?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, message, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      {icon && <div className="text-outline mb-4">{icon}</div>}
      <h3 className="font-headline-md text-lg text-on-surface mb-1">{title}</h3>
      {message && <p className="text-sm text-on-surface-variant max-w-sm">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

interface BadgeProps {
  children: ReactNode;
  color?: 'primary' | 'secondary' | 'tertiary' | 'success' | 'error' | 'outline';
  pulse?: boolean;
}

export function Badge({ children, color = 'outline', pulse = false }: BadgeProps) {
  const colors: Record<string, string> = {
    primary: 'bg-primary/10 text-primary border-primary/20',
    secondary: 'bg-secondary/10 text-secondary border-secondary/20',
    tertiary: 'bg-tertiary/10 text-tertiary border-tertiary/20',
    success: 'bg-success/10 text-success border-success/20',
    error: 'bg-error/10 text-error border-error/20',
    outline: 'bg-surface-high text-on-surface-variant border-outline-variant/30',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border ${colors[color]}`}
    >
      {pulse && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
      {children}
    </span>
  );
}
