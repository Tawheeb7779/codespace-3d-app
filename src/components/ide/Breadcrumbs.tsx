import { ChevronRight } from 'lucide-react';
import { FileIcon } from '@/components/ide/FileIcon';
import { useFileStore } from '@/stores/fileStore';

export function Breadcrumbs({ path }: { path: string }) {
  const meta = useFileStore((s) => s.meta);
  const segments = path.split('/');

  return (
    <nav
      aria-label="File path"
      className="flex h-6 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-canvas px-3 text-sm text-ink-faint"
    >
      <span className="shrink-0">{meta?.name}</span>
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex shrink-0 items-center gap-1">
          <ChevronRight aria-hidden className="h-3 w-3" />
          {index === segments.length - 1 ? (
            <span className="flex items-center gap-1 text-ink">
              <FileIcon path={path} />
              {segment}
            </span>
          ) : (
            segment
          )}
        </span>
      ))}
    </nav>
  );
}
