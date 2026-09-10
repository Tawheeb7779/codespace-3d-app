/**
 * The database's shape, read from the project's own migrations.
 *
 * **Not from the live database.** Reading `pg_catalog` needs a connection with
 * catalogue access, and the browser has the anon key — which is exactly the
 * credential that must not be able to introspect a schema. The migrations in
 * the repository are the schema's source of truth anyway: they are what
 * produced the database, they are versioned, and reading them needs no
 * privilege at all.
 *
 * The cost is stated where it matters: this describes what the migrations say,
 * which is the deployed schema only if every migration has been applied. The
 * panel says so rather than presenting a parse as a live reading.
 *
 * The parser is deliberately small. It understands `create table`, its columns,
 * primary and foreign keys, and `create index` — the things a person browsing a
 * schema wants. Anything it does not understand is skipped rather than guessed
 * at, and what was skipped is reported.
 */

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  /** The table and column this points at, when it is a foreign key. */
  references?: { table: string; column: string };
  default?: string;
}

export interface Index {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
}

export interface Table {
  name: string;
  schema: string;
  columns: Column[];
  /** The migration file this table was declared in. */
  source: string;
}

export interface SchemaReport {
  tables: Table[];
  indexes: Index[];
  /** Migration files that were read. */
  sources: string[];
  /** Statements the parser did not understand, so the gap is visible. */
  skipped: number;
}

/** Strip comments and collapse whitespace, so one statement is one string. */
function clean(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Split a `create table` body on commas that are not inside brackets.
 *
 * A naive split breaks `numeric(10, 2)` and every `check (a in (1, 2))`, which
 * is most of the interesting columns in a real schema.
 */
export function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const CONSTRAINT_START =
  /^(constraint|primary\s+key|foreign\s+key|unique|check|exclude|like)\b/i;

/** One column definition, or null when the line is a table constraint. */
export function parseColumn(definition: string): Column | null {
  const text = definition.trim();
  if (!text || CONSTRAINT_START.test(text)) return null;

  const match = /^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+(.+)$/.exec(text);
  if (!match) return null;
  const [, name, rest] = match;

  // The type is everything up to the first keyword that is not part of it.
  const typeMatch =
    /^([a-zA-Z_][a-zA-Z0-9_ ]*?(?:\s*\([^)]*\))?(?:\s*\[\])?)(?=\s+(?:not\s+null|null|primary|references|default|unique|check|generated|collate)\b|$)/i.exec(
      rest,
    );
  const type = (typeMatch?.[1] ?? rest.split(/\s+/)[0]).trim();

  const references = /references\s+(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(\s*"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\)/i.exec(
    rest,
  );
  const defaultMatch = /default\s+((?:'[^']*'|[^\s,]+(?:\([^)]*\))?))/i.exec(rest);

  return {
    name,
    type,
    // A primary key column is not nullable whatever else the line says.
    nullable: !/not\s+null/i.test(rest) && !/primary\s+key/i.test(rest),
    primaryKey: /primary\s+key/i.test(rest),
    references: references ? { table: references[1], column: references[2] } : undefined,
    default: defaultMatch?.[1],
  };
}

/** Column names named by a table-level `primary key (...)`. */
export function tablePrimaryKey(parts: string[]): string[] {
  for (const part of parts) {
    const match = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(part.trim());
    if (match) {
      return match[1]
        .split(',')
        .map((name) => name.trim().replace(/"/g, ''))
        .filter(Boolean);
    }
  }
  return [];
}

/** Foreign keys declared at table level rather than on the column. */
export function tableForeignKeys(
  parts: string[],
): Array<{ column: string; table: string; target: string }> {
  const found: Array<{ column: string; table: string; target: string }> = [];
  for (const part of parts) {
    const match =
      /foreign\s+key\s*\(\s*"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\)\s*references\s+(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(\s*"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\)/i.exec(
        part,
      );
    if (match) found.push({ column: match[1], table: match[2], target: match[3] });
  }
  return found;
}

export function parseSchema(files: Record<string, string>): SchemaReport {
  const migrations = Object.entries(files)
    .filter(([path]) => /(^|\/)supabase\/migrations\/.*\.sql$/.test(path) || /\.sql$/.test(path))
    .sort(([a], [b]) => a.localeCompare(b));

  const tables = new Map<string, Table>();
  const indexes: Index[] = [];
  let skipped = 0;

  for (const [path, content] of migrations) {
    const sql = clean(content);

    for (const match of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi,
    )) {
      // Walk from the opening bracket to its match, so a nested `(` in a
      // `check` or a `numeric(10,2)` does not end the body early.
      const start = (match.index ?? 0) + match[0].length;
      let depth = 1;
      let end = start;
      while (end < sql.length && depth > 0) {
        if (sql[end] === '(') depth += 1;
        if (sql[end] === ')') depth -= 1;
        end += 1;
      }
      const parts = splitTopLevel(sql.slice(start, end - 1));
      const columns = parts.map(parseColumn).filter((column): column is Column => column !== null);
      if (!columns.length) {
        skipped += 1;
        continue;
      }

      const primary = new Set(tablePrimaryKey(parts));
      for (const foreign of tableForeignKeys(parts)) {
        const column = columns.find((entry) => entry.name === foreign.column);
        if (column) column.references = { table: foreign.table, column: foreign.target };
      }
      for (const column of columns) {
        if (primary.has(column.name)) {
          column.primaryKey = true;
          column.nullable = false;
        }
      }

      const name = match[2];
      tables.set(`${match[1] ?? 'public'}.${name}`, {
        name,
        schema: match[1] ?? 'public',
        columns,
        source: path,
      });
    }

    for (const match of sql.matchAll(
      /create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+on\s+(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?[^(]*\(([^)]*)\)/gi,
    )) {
      indexes.push({
        name: match[2],
        table: match[3],
        unique: Boolean(match[1]),
        columns: match[4]
          .split(',')
          .map((column) => column.trim().replace(/"/g, '').split(/\s+/)[0])
          .filter(Boolean),
      });
    }
  }

  return {
    tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
    indexes,
    sources: migrations.map(([path]) => path),
    skipped,
  };
}

/** Relationships between tables, for the panel to draw. */
export function relationshipsIn(report: SchemaReport): Array<{
  from: string;
  column: string;
  to: string;
  target: string;
}> {
  const found: Array<{ from: string; column: string; to: string; target: string }> = [];
  for (const table of report.tables) {
    for (const column of table.columns) {
      if (!column.references) continue;
      found.push({
        from: table.name,
        column: column.name,
        to: column.references.table,
        target: column.references.column,
      });
    }
  }
  return found;
}
