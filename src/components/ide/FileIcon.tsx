import { Folder, FolderOpen } from 'lucide-react';
import { getLanguage } from '@/lib/languages';
import { cx } from '@/lib/utils';

export function FileIcon({ path, className }: { path: string; className?: string }) {
  const info = getLanguage(path);
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-line',
        'bg-surface-raised text-[8px] font-bold leading-none tracking-tight',
        info.color,
        className,
      )}
    >
      {info.glyph.slice(0, 3)}
    </span>
  );
}

export function DirIcon({ open, className }: { open: boolean; className?: string }) {
  const Icon = open ? FolderOpen : Folder;
  return <Icon aria-hidden className={cx('h-3.5 w-3.5 shrink-0 text-ink-faint', className)} />;
}
