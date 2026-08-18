import { type ButtonHTMLAttributes } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function IconButton({ active, className = '', children, ...props }: IconButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center w-8 h-8 rounded transition-all focus-ring ${
        active
          ? 'bg-primary/10 text-primary border border-primary/30'
          : 'text-on-surface-variant hover:text-on-surface hover:bg-white/5'
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
