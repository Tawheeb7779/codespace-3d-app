import { useMemo } from 'react';
import { diffLines } from '@/lib/diff';
import { cx } from '@/lib/utils';

/**
 * Side-by-side-free unified diff. Chosen over a two-column view because the
 * source-control panel is narrow and long lines matter more than symmetry.
 */
export function DiffViewer({
  before,
  after,
  emptyLabel = 'No changes',
}: {
  before: string;
  after: string;
  emptyLabel?: string;
}) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const changed = lines.some((line) => line.op !== 'equal');

  if (!changed) {
    return <p className="p-4 text-center text-sm text-ink-faint">{emptyLabel}</p>;
  }

  return (
    <div className="scrollbar-thin h-full overflow-auto font-mono text-sm">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, index) => (
            <tr
              key={index}
              className={cx(
                line.op === 'add' && 'bg-positive/10',
                line.op === 'remove' && 'bg-danger/10',
              )}
            >
              <td className="w-10 select-none border-r border-line px-1.5 text-right align-top text-ink-faint">
                {line.oldLine ?? ''}
              </td>
              <td className="w-10 select-none border-r border-line px-1.5 text-right align-top text-ink-faint">
                {line.newLine ?? ''}
              </td>
              <td
                className={cx(
                  'w-4 select-none px-1 align-top',
                  line.op === 'add' && 'text-positive',
                  line.op === 'remove' && 'text-danger',
                  line.op === 'equal' && 'text-ink-faint',
                )}
              >
                {line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' '}
              </td>
              <td className="whitespace-pre-wrap break-all px-1 align-top text-ink">
                {line.text || ' '}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
