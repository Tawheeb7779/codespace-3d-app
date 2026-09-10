/**
 * Running a query from the browser, and the honest limit on which ones.
 *
 * **Arbitrary SQL is not available here, and this does not pretend otherwise.**
 * Sending SQL to Postgres needs a connection or a server-side function; the
 * browser holds the anon key and talks to PostgREST, which accepts filters
 * rather than statements. A SQL box that silently ran something *else* — or
 * showed a plausible result it did not obtain — would be the worst kind of fake
 * in a database tool, because the result is what gets acted on.
 *
 * So a restricted `SELECT` is genuinely translated and genuinely run, and
 * everything outside that subset is refused **by name**, with what would be
 * needed to support it. A refusal is a true answer; a result nobody computed is
 * not.
 *
 * **Row-level security applies to every query.** These run as the signed-in
 * user through PostgREST, so a person sees exactly what the database's policies
 * let them see — the same rows the application would get, which is the useful
 * thing to be looking at.
 */

export interface ParsedQuery {
  table: string;
  columns: string[];
  filters: Array<{ column: string; operator: FilterOperator; value: string }>;
  orderBy?: { column: string; ascending: boolean };
  limit: number;
}

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'is';

export interface Unsupported {
  /** The construct that could not be translated. */
  construct: string;
  /** Why, and what would be needed instead. */
  reason: string;
}

/** Rows one query may return, so a browse cannot pull a whole table. */
export const MAX_ROWS = 200;
export const DEFAULT_LIMIT = 50;

const SQL_OPERATORS: Array<{ sql: string; operator: FilterOperator }> = [
  { sql: '>=', operator: 'gte' },
  { sql: '<=', operator: 'lte' },
  { sql: '!=', operator: 'neq' },
  { sql: '<>', operator: 'neq' },
  { sql: '=', operator: 'eq' },
  { sql: '>', operator: 'gt' },
  { sql: '<', operator: 'lt' },
];

/**
 * Constructs this cannot translate, named so the refusal explains itself.
 *
 * Each says what would be required, because "unsupported" without a reason
 * reads as a bug rather than a boundary.
 */
const UNSUPPORTED: Array<{ pattern: RegExp; construct: string; reason: string }> = [
  {
    pattern: /\bjoin\b/i,
    construct: 'JOIN',
    reason:
      'PostgREST expresses joins as embedded resources over declared foreign keys, not as SQL joins. Query one table, or add a database function.',
  },
  {
    pattern: /\bgroup\s+by\b/i,
    construct: 'GROUP BY',
    reason: 'Aggregation happens in the database. Expose it as a view or a function and select from that.',
  },
  {
    pattern: /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i,
    construct: 'a statement that changes the database',
    reason:
      'This runs read-only queries. Changing data or schema from a browser panel is not something this offers — use a migration, or the application itself.',
  },
  {
    pattern: /\bunion\b/i,
    construct: 'UNION',
    reason: 'PostgREST has no equivalent. Expose the combined result as a view.',
  },
  {
    pattern: /\bwith\b\s+\w+\s+\bas\b/i,
    construct: 'a common table expression',
    reason: 'These are evaluated by Postgres, and this does not send SQL to Postgres.',
  },
  {
    pattern: /\(\s*select\b/i,
    construct: 'a subquery',
    reason: 'These are evaluated by Postgres, and this does not send SQL to Postgres.',
  },
];

export type ParseResult =
  | { ok: true; query: ParsedQuery }
  | { ok: false; unsupported: Unsupported };

/**
 * Translate a restricted `SELECT`, or say precisely why not.
 *
 * The supported shape is `select <columns> from <table> [where <simple
 * conditions>] [order by <column> [asc|desc]] [limit <n>]`, with conditions
 * joined by `and`.
 */
export function parseQuery(sql: string): ParseResult {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().replace(/;$/, '');

  if (!text) {
    return {
      ok: false,
      unsupported: { construct: 'an empty query', reason: 'Write a select statement.' },
    };
  }

  for (const entry of UNSUPPORTED) {
    if (entry.pattern.test(text)) {
      return { ok: false, unsupported: { construct: entry.construct, reason: entry.reason } };
    }
  }

  const match =
    /^select\s+(.+?)\s+from\s+(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(asc|desc))?)?(?:\s+limit\s+(\d+))?$/i.exec(
      text,
    );

  if (!match) {
    return {
      ok: false,
      unsupported: {
        construct: 'that query',
        reason:
          'The supported shape is: select <columns> from <table> [where <column> <op> <value> [and …]] [order by <column> [asc|desc]] [limit <n>].',
      },
    };
  }

  const [, rawColumns, table, where, orderColumn, direction, limit] = match;
  const columns = rawColumns
    .split(',')
    .map((column) => column.trim().replace(/"/g, ''))
    .filter(Boolean);

  const filters: ParsedQuery['filters'] = [];
  if (where) {
    for (const clause of where.split(/\s+and\s+/i)) {
      const condition = clause.trim();
      if (/\bor\b/i.test(condition)) {
        return {
          ok: false,
          unsupported: {
            construct: 'OR in a where clause',
            reason: 'Only conditions joined by AND are translated. Run the parts separately.',
          },
        };
      }

      const nullMatch = /^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+is\s+(not\s+)?null$/i.exec(condition);
      if (nullMatch) {
        filters.push({
          column: nullMatch[1],
          operator: 'is',
          value: nullMatch[2] ? 'not.null' : 'null',
        });
        continue;
      }

      const likeMatch = /^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+like\s+'(.*)'$/i.exec(condition);
      if (likeMatch) {
        filters.push({ column: likeMatch[1], operator: 'like', value: likeMatch[2] });
        continue;
      }

      const operator = SQL_OPERATORS.find((entry) => condition.includes(entry.sql));
      if (!operator) {
        return {
          ok: false,
          unsupported: {
            construct: `the condition "${condition}"`,
            reason: 'Supported comparisons are =, !=, <, <=, >, >=, LIKE and IS [NOT] NULL.',
          },
        };
      }
      const [rawColumn, ...rest] = condition.split(operator.sql);
      const value = rest.join(operator.sql).trim().replace(/^'(.*)'$/, '$1');
      filters.push({
        column: rawColumn.trim().replace(/"/g, ''),
        operator: operator.operator,
        value,
      });
    }
  }

  return {
    ok: true,
    query: {
      table,
      columns: columns.length === 1 && columns[0] === '*' ? ['*'] : columns,
      filters,
      orderBy: orderColumn
        ? { column: orderColumn, ascending: (direction ?? 'asc').toLowerCase() === 'asc' }
        : undefined,
      // Clamped: a browse must not try to pull a whole table into a panel.
      limit: Math.min(MAX_ROWS, limit ? Number(limit) : DEFAULT_LIMIT),
    },
  };
}

/** What the query will be, for the panel to show before it runs. */
export function describeQuery(query: ParsedQuery): string {
  const parts = [`from ${query.table}`, `select ${query.columns.join(', ')}`];
  for (const filter of query.filters) {
    parts.push(`${filter.column} ${filter.operator} ${filter.value}`);
  }
  if (query.orderBy) {
    parts.push(`order ${query.orderBy.column} ${query.orderBy.ascending ? 'asc' : 'desc'}`);
  }
  parts.push(`limit ${query.limit}`);
  return parts.join(' · ');
}

/**
 * A database error, in words that say what to do.
 *
 * The one that matters most is an empty result caused by row-level security
 * rather than by there being no rows: they are identical on screen and mean
 * completely different things, and somebody debugging the second when it is the
 * first can lose an afternoon.
 */
export function explainDatabaseError(message: string, code?: string): string {
  if (code === '42P01' || /relation .* does not exist/i.test(message)) {
    return `That table is not exposed to the API. Check the name, and that the schema is exposed in your PostgREST settings. (${message})`;
  }
  if (code === '42501' || /permission denied/i.test(message)) {
    return `The database refused this. Row-level security decides what this account may read, and it said no. (${message})`;
  }
  if (code === '42703' || /column .* does not exist/i.test(message)) {
    return `That column is not on this table. (${message})`;
  }
  return message;
}

/** What an empty result might mean, given that RLS is in force. */
export const EMPTY_RESULT_NOTE =
  'No rows came back. That can mean the table is empty, or that row-level security let none of them through for this account — the database gives the same answer for both.';
