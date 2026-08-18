import { type ReactNode } from 'react';

interface CardProps {
  className?: string;
  hover?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

export function Card({ className = '', hover = false, onClick, children }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={`glass-panel rounded-lg ${hover ? 'glow-active cursor-pointer' : ''} ${className}`}
    >
      {children}
    </div>
  );
}
