import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import {
  EMPTY_RESULT_NOTE,
  explainDatabaseError,
  parseQuery,
  type ParsedQuery,
  type Unsupported,
} from '@/lib/db/query';

/**
 * Running a query, as the signed-in user.
 *
 * Every query goes through the ordinary Supabase client with the anon key, so
 * row-level security applies exactly as it does to the application. There is no
 * privileged path: the service-role key is a server secret and does not exist
 * in this build's client, which is why this browses what the *user* can see
 * rather than everything in the table — and that is the more useful thing to be
 * looking at when debugging what somebody is actually served.
 *
 * **A refusal is a result.** When the query cannot be translated, or the
 * database says no, that is reported as what happened. Nothing here produces
 * rows it did not receive.
 */

export interface QueryOutcome {
  rows: Array<Record<string, unknown>>;
  /** Column names, in the order the first row presents them. */
  columns: string[];
  durationMs: number;
  /** Said when the result is empty, because empty is ambiguous under RLS. */
  note?: string;
}

interface DbState {
  sql: string;
  running: boolean;
  outcome: QueryOutcome | null;
  /** A database error, already explained. */
  error: string | null;
  /** A construct this cannot translate, with the reason. */
  unsupported: Unsupported | null;
  /** The last query that actually ran, for the panel to show. */
  lastQuery: ParsedQuery | null;

  setSql: (sql: string) => void;
  run: () => Promise<void>;
  clear: () => void;
}

export const useDbStore = create<DbState>()((set, get) => ({
  sql: '',
  running: false,
  outcome: null,
  error: null,
  unsupported: null,
  lastQuery: null,

  setSql: (sql) => set({ sql }),

  async run() {
    if (get().running) return;
    set({ error: null, unsupported: null, outcome: null });

    if (!supabase) {
      set({ error: 'No Supabase project is configured, so there is no database to query.' });
      return;
    }

    const parsed = parseQuery(get().sql);
    if (!parsed.ok) {
      // Named rather than attempted: running something *else* and showing its
      // result would be the worst kind of wrong answer in a database tool.
      set({ unsupported: parsed.unsupported });
      return;
    }

    set({ running: true, lastQuery: parsed.query });
    const started = performance.now();

    try {
      let builder = supabase
        .from(parsed.query.table)
        .select(parsed.query.columns.join(','));

      for (const filter of parsed.query.filters) {
        if (filter.operator === 'is') {
          builder = builder.is(filter.column, filter.value === 'not.null' ? 'not.null' : null);
        } else if (filter.operator === 'like') {
          builder = builder.like(filter.column, filter.value);
        } else {
          // The operators are a closed set checked by the parser, but the
          // client's overloads do not narrow across a union — so the call is
          // made through a shape that says what it is.
          const apply = builder as unknown as Record<
            string,
            (column: string, value: string) => typeof builder
          >;
          builder = apply[filter.operator](filter.column, filter.value);
        }
      }

      if (parsed.query.orderBy) {
        builder = builder.order(parsed.query.orderBy.column, {
          ascending: parsed.query.orderBy.ascending,
        });
      }

      const { data, error } = await builder.limit(parsed.query.limit);
      const durationMs = Math.round(performance.now() - started);

      if (error) {
        set({
          running: false,
          error: explainDatabaseError(error.message, error.code),
        });
        return;
      }

      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      set({
        running: false,
        outcome: {
          rows,
          columns: rows.length ? Object.keys(rows[0]) : parsed.query.columns,
          durationMs,
          // Empty and refused-by-policy are the same answer from the database.
          note: rows.length === 0 ? EMPTY_RESULT_NOTE : undefined,
        },
      });
    } catch (failure) {
      set({
        running: false,
        error: failure instanceof Error ? failure.message : 'The query failed.',
      });
    }
  },

  clear: () => set({ outcome: null, error: null, unsupported: null }),
}));
