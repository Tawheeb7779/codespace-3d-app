import { type ReactNode } from 'react';

interface PanelProps {
  title?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Panel({ title, icon, actions, className = '', bodyClassName = '', children }: PanelProps) {
  return (
    <div className={`glass-panel rounded-lg flex flex-col ${className}`}>
      {title && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-outline-variant/10">
          <div className="flex items-center gap-2">
            {icon && <span className="text-outline">{icon}</span>}
            <h3 className="font-label-caps text-label-caps text-on-surface-variant">{title}</h3>
          </div>
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </div>
      )}
      <div className={`flex-1 overflow-auto ${bodyClassName}`}>{children}</div>
    </div>
  );
}
