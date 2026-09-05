/**
 * Line diff built on a Myers-style LCS table with common prefix/suffix
 * trimming. Used by the diff viewer, the VCS status counts and three-way merge.
 */

export type DiffOp = 'equal' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  /** 1-based line number in the original file, null for additions. */
  oldLine: number | null;
  /** 1-based line number in the new file, null for removals. */
  newLine: number | null;
  text: string;
}

export interface DiffStat {
  additions: number;
  deletions: number;
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** Longest common subsequence indices between two line arrays. */
function lcsMatrix(a: string[], b: string[]): Uint32Array {
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + j + 1] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  return table;
}

const MAX_CELLS = 4_000_000;

/**
 * Diff two texts line by line.
 *
 * For very large inputs the quadratic table is skipped and the files are
 * reported as a wholesale replacement, which keeps the UI responsive instead
 * of freezing the tab.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  const out: DiffLine[] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  for (let i = 0; i < start; i++) {
    out.push({ op: 'equal', oldLine: i + 1, newLine: i + 1, text: a[i] });
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length * midB.length > MAX_CELLS) {
    midA.forEach((text, i) => out.push({ op: 'remove', oldLine: start + i + 1, newLine: null, text }));
    midB.forEach((text, i) => out.push({ op: 'add', oldLine: null, newLine: start + i + 1, text }));
  } else {
    const w = midB.length + 1;
    const table = lcsMatrix(midA, midB);
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        out.push({ op: 'equal', oldLine: start + i + 1, newLine: start + j + 1, text: midA[i] });
        i++;
        j++;
      } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
        out.push({ op: 'remove', oldLine: start + i + 1, newLine: null, text: midA[i] });
        i++;
      } else {
        out.push({ op: 'add', oldLine: null, newLine: start + j + 1, text: midB[j] });
        j++;
      }
    }
    while (i < midA.length) {
      out.push({ op: 'remove', oldLine: start + i + 1, newLine: null, text: midA[i] });
      i++;
    }
    while (j < midB.length) {
      out.push({ op: 'add', oldLine: null, newLine: start + j + 1, text: midB[j] });
      j++;
    }
  }

  for (let k = 0; k < a.length - endA; k++) {
    out.push({ op: 'equal', oldLine: endA + k + 1, newLine: endB + k + 1, text: a[endA + k] });
  }
  return out;
}

export function diffStat(oldText: string, newText: string): DiffStat {
  let additions = 0;
  let deletions = 0;
  for (const line of diffLines(oldText, newText)) {
    if (line.op === 'add') additions++;
    else if (line.op === 'remove') deletions++;
  }
  return { additions, deletions };
}

/**
 * A unified diff for one file, the shape every reviewer already reads.
 *
 * Context lines are limited so a large file with one changed line produces a
 * small hunk rather than the whole file — which is what makes this safe to
 * hand to a model, and readable when a person sees it.
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  context = 3,
): string {
  if (before === after) return '';
  const lines = diffLines(before, after);
  const changed = lines
    .map((line, index) => (line.op === 'equal' ? -1 : index))
    .filter((index) => index >= 0);
  if (!changed.length) return '';

  // Keep every line within `context` of a change, and mark where runs break.
  const keep = new Set<number>();
  for (const index of changed) {
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) {
      keep.add(i);
    }
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let previous = -1;
  for (let index = 0; index < lines.length; index++) {
    if (!keep.has(index)) continue;
    const line = lines[index];
    if (previous !== -1 && index !== previous + 1) {
      out.push(`@@ -${line.oldLine ?? 0} +${line.newLine ?? 0} @@`);
    } else if (previous === -1) {
      out.push(`@@ -${line.oldLine ?? 0} +${line.newLine ?? 0} @@`);
    }
    const marker = line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' ';
    out.push(`${marker}${line.text}`);
    previous = index;
  }
  return out.join('\n');
}

export interface MergeResult {
  text: string;
  conflicted: boolean;
}

/**
 * Three-way merge of a single file. Non-overlapping hunks are combined; when
 * both sides changed the same region the result carries conflict markers and
 * `conflicted` is true so the caller can block the commit.
 */
export function mergeThreeWay(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs) return { text: ours, conflicted: false };
  if (base === ours) return { text: theirs, conflicted: false };
  if (base === theirs) return { text: ours, conflicted: false };

  const baseLines = splitLines(base);
  const ourLines = splitLines(ours);
  const theirLines = splitLines(theirs);

  const ourDiff = diffLines(base, ours);
  const theirDiff = diffLines(base, theirs);

  // Map every base line to its replacement on each side.
  const build = (diff: DiffLine[]) => {
    const map = new Map<number, string[]>();
    const leading: string[] = [];
    let current = 0;
    for (const line of diff) {
      if (line.op === 'equal') {
        current = line.oldLine!;
        map.set(current, [line.text]);
      } else if (line.op === 'remove') {
        current = line.oldLine!;
        map.set(current, []);
      } else if (current === 0) {
        leading.push(line.text);
      } else {
        map.set(current, [...(map.get(current) ?? []), line.text]);
      }
    }
    return { map, leading };
  };

  const our = build(ourDiff);
  const their = build(theirDiff);

  const out: string[] = [];
  let conflicted = false;

  if (our.leading.join('\n') === their.leading.join('\n')) {
    out.push(...our.leading);
  } else if (our.leading.length && their.leading.length) {
    conflicted = true;
    out.push('<<<<<<< ours', ...our.leading, '=======', ...their.leading, '>>>>>>> theirs');
  } else {
    out.push(...our.leading, ...their.leading);
  }

  for (let i = 1; i <= baseLines.length; i++) {
    const original = [baseLines[i - 1]];
    const a = our.map.get(i) ?? original;
    const b = their.map.get(i) ?? original;
    const aChanged = a.join('\n') !== original.join('\n');
    const bChanged = b.join('\n') !== original.join('\n');
    if (!aChanged) out.push(...b);
    else if (!bChanged) out.push(...a);
    else if (a.join('\n') === b.join('\n')) out.push(...a);
    else {
      conflicted = true;
      out.push('<<<<<<< ours', ...a, '=======', ...b, '>>>>>>> theirs');
    }
  }

  void ourLines;
  void theirLines;
  return { text: out.join('\n'), conflicted };
}
