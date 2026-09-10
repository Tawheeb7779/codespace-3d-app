import { useMemo, useState } from 'react';
import { AlertCircle, Database, KeyRound, Link2, Play, RefreshCw, Table2 } from 'lucide-react';
import { PanelHeader, EmptyState, Badge, Spinner } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { useDbStore } from '@/stores/dbStore';
import { isSupabaseConfigured } from '@/lib/supabase';
import { parseSchema, relationshipsIn, type Table } from '@/lib/db/schema';
import { DEFAULT_LIMIT, describeQuery } from '@/lib/db/query';
import { cx } from '@/lib/utils';

/**
 * The database, from two honest sources.
 *
 * The **schema** is read from this project's migrations. Introspecting a live
 * database needs catalogue access, and the browser holds the anon key — which
 * is precisely the credential that must not be able to do that. The migrations
 * are the schema's source of truth anyway; the panel says that what it shows is
 * what they declare, which is the deployed schema only if they have all been
 * applied.
 *
 * The **rows** are real, fetched through the ordinary client as the signed-in
 * user, so row-level security applies exactly as it does to the application.
 * That is why this shows what the *user* can see rather than everything in the
 * table, and it is the more useful thing when debugging what somebody is served.
 *
 * Arbitrary SQL is not offered, because the browser cannot send SQL to Postgres.
 * A restricted `select` is genuinely translated and run, and anything outside
 * that is refused by name with what would be needed — never quietly turned into
 * a different query whose result somebody then acts on.
 */

function TableDetail({ table }: { table: Table }) {
  const reveal = useEditorStore((s) => s.revealLocation);
  const setSql = useDbStore((s) => s.setSql);

  return (
    <div className="border-b border-line px-2.5 py-2">
      <p className="flex items-center gap-1.5">
        <Table2 aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-base text-ink">{table.name}</span>
        <Badge>{table.columns.length} columns</Badge>
      </p>

      <div className="mt-1 overflow-hidden rounded border border-line">
        {table.columns.map((column) => (
          <div
            key={column.name}
            className="flex items-baseline gap-1.5 border-b border-line px-1.5 py-0.5 text-sm last:border-0"
          >
            {column.primaryKey && (
              <KeyRound aria-label="Primary key" className="h-3 w-3 shrink-0 text-caution" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-ink">{column.name}</span>
            <span className="shrink-0 font-mono text-ink-faint">{column.type}</span>
            {!column.nullable && <span className="shrink-0 text-xs text-ink-faint">not null</span>}
            {column.references && (
              <span className="flex shrink-0 items-center gap-0.5 text-xs text-accent">
                <Link2 aria-hidden className="h-2.5 w-2.5" />
                {column.references.table}.{column.references.column}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Button
          size="xs"
          onClick={() => setSql(`select * from ${table.name} limit ${DEFAULT_LIMIT}`)}
        >
          Query it
        </Button>
        <Button size="xs" onClick={() => reveal(table.source, 1, 1)}>
          Open {table.source.split('/').pop()}
        </Button>
      </div>
    </div>
  );
}

export function DatabasePanel() {
  const files = useFileStore((s) => s.files);
  const { sql, running, outcome, error, unsupported, lastQuery, setSql, run } = useDbStore();
  const [tab, setTab] = useState<'schema' | 'query'>('schema');
  const [openTable, setOpenTable] = useState<string | null>(null);

  const schema = useMemo(() => parseSchema(files), [files]);
  const relationships = useMemo(() => relationshipsIn(schema), [schema]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Database"
        actions={
          <IconButton
            label="Re-read the migrations"
            size="xs"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => setOpenTable(null)}
          />
        }
      />

      <div role="tablist" aria-label="Database view" className="flex shrink-0 border-b border-line">
        {(
          [
            ['schema', `Schema${schema.tables.length ? ` (${schema.tables.length})` : ''}`],
            ['query', 'Query'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cx(
              'tap-target flex-1 px-2 py-1.5 text-sm transition-colors',
              tab === value
                ? 'border-b-2 border-accent text-ink'
                : 'border-b-2 border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {tab === 'schema' && (
          <>
            {/* Where this came from, and what that means it is. */}
            <p className="border-b border-line px-2.5 py-1.5 text-sm text-ink-faint">
              <span>
                {schema.sources.length
                  ? `Read from ${schema.sources.length} migration file${schema.sources.length === 1 ? '' : 's'}. This is what the migrations declare — the deployed schema only if they have all been applied. The browser holds the anon key and cannot introspect a live database, which is as it should be.`
                  : 'This project has no SQL migrations, so there is no schema to read. The browser cannot introspect a live database — that needs catalogue access the anon key does not have.'}
              </span>
            </p>

            {!schema.tables.length ? (
              <EmptyState
                icon={<Database className="h-4 w-4" />}
                title="No tables declared"
                description="Add a migration with a create table statement and it will appear here."
              />
            ) : (
              <>
                {schema.tables.map((table) => (
                  <div key={`${table.schema}.${table.name}`}>
                    <button
                      type="button"
                      aria-expanded={openTable === table.name}
                      onClick={() => setOpenTable(openTable === table.name ? null : table.name)}
                      className="flex w-full items-center gap-1.5 border-b border-line px-2.5 py-1.5 text-left hover:bg-surface-raised"
                    >
                      <Table2 aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" />
                      <span className="min-w-0 flex-1 truncate font-mono text-base text-ink-muted">
                        {table.name}
                      </span>
                      <span className="shrink-0 text-sm tabular-nums text-ink-faint">
                        {table.columns.length}
                      </span>
                    </button>
                    {openTable === table.name && <TableDetail table={table} />}
                  </div>
                ))}

                {relationships.length > 0 && (
                  <section className="border-b border-line px-2.5 py-2">
                    <p className="panel-label">Relationships</p>
                    {relationships.map((relationship) => (
                      <p
                        key={`${relationship.from}.${relationship.column}`}
                        className="truncate font-mono text-sm text-ink-muted"
                      >
                        {relationship.from}.{relationship.column} → {relationship.to}.
                        {relationship.target}
                      </p>
                    ))}
                  </section>
                )}

                {schema.indexes.length > 0 && (
                  <section className="border-b border-line px-2.5 py-2">
                    <p className="panel-label">Indexes ({schema.indexes.length})</p>
                    {schema.indexes.slice(0, 30).map((index) => (
                      <p key={index.name} className="truncate font-mono text-sm text-ink-muted">
                        {index.unique ? 'unique ' : ''}
                        {index.table} ({index.columns.join(', ')})
                      </p>
                    ))}
                  </section>
                )}

                {schema.skipped > 0 && (
                  <p className="px-2.5 py-2 text-sm text-caution">
                    <span>
                      {schema.skipped} create-table statement
                      {schema.skipped === 1 ? '' : 's'} could not be parsed and {schema.skipped === 1 ? 'is' : 'are'} not
                      shown above.
                    </span>
                  </p>
                )}
              </>
            )}
          </>
        )}

        {tab === 'query' && (
          <div className="p-2.5">
            {!isSupabaseConfigured ? (
              <EmptyState
                icon={<Database className="h-4 w-4" />}
                title="No database configured"
                description="Queries run against a Supabase project. In local development mode there is no database to query."
              />
            ) : (
              <>
                <textarea
                  aria-label="Query"
                  value={sql}
                  rows={4}
                  placeholder={`select id, name from projects where visibility = 'public' order by name limit 20`}
                  onChange={(event) => setSql(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void run();
                  }}
                  className="w-full resize-y rounded border border-line bg-surface-sunken p-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="primary"
                    loading={running}
                    disabled={running || !sql.trim()}
                    leading={<Play className="h-3 w-3" />}
                    onClick={() => void run()}
                  >
                    Run
                  </Button>
                  {lastQuery && !running && (
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink-faint">
                      {describeQuery(lastQuery)}
                    </span>
                  )}
                </div>

                {/* The boundary, said where somebody would otherwise assume. */}
                <p className="mt-1.5 text-sm text-ink-faint">
                  <span>
                    Read-only selects, run as you through the ordinary client — so row-level
                    security decides what comes back, exactly as it does for the application. The
                    browser cannot send SQL to Postgres, so joins, aggregates and writes are refused
                    rather than translated into something else.
                  </span>
                </p>

                {unsupported && (
                  <div role="alert" className="mt-2 rounded border border-caution/40 bg-caution/5 p-2">
                    <p className="flex items-start gap-1.5 text-sm text-caution">
                      <AlertCircle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        Cannot run {unsupported.construct}. {unsupported.reason}
                      </span>
                    </p>
                  </div>
                )}

                {error && (
                  <div role="alert" className="mt-2 rounded border border-danger/40 bg-danger/5 p-2">
                    <p className="text-sm text-danger">{error}</p>
                  </div>
                )}

                {running && (
                  <p className="mt-2 flex items-center gap-2 text-sm text-ink-faint">
                    <Spinner className="h-3 w-3" />
                    <span>Running…</span>
                  </p>
                )}

                {outcome && (
                  <div className="mt-2">
                    <p className="flex items-center gap-1.5 text-sm text-ink-faint">
                      <Badge tone={outcome.rows.length ? 'positive' : 'neutral'}>
                        {outcome.rows.length} rows
                      </Badge>
                      <span className="tabular-nums">{outcome.durationMs}ms</span>
                    </p>

                    {/* Empty and refused-by-policy are the same answer from the
                        database, and confusing them costs an afternoon. */}
                    {outcome.note && (
                      <p className="mt-1 text-sm text-caution">
                        <span>{outcome.note}</span>
                      </p>
                    )}

                    {outcome.rows.length > 0 && (
                      <div className="scrollbar-thin mt-1.5 overflow-x-auto rounded border border-line">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-line bg-surface-sunken">
                              {outcome.columns.map((column) => (
                                <th
                                  key={column}
                                  scope="col"
                                  className="whitespace-nowrap px-1.5 py-1 text-left font-mono font-medium text-ink"
                                >
                                  {column}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {outcome.rows.map((row, index) => (
                              <tr key={index} className="border-b border-line last:border-0">
                                {outcome.columns.map((column) => (
                                  <td
                                    key={column}
                                    className="max-w-[16rem] truncate px-1.5 py-0.5 font-mono text-ink-muted"
                                  >
                                    {row[column] === null
                                      ? 'null'
                                      : typeof row[column] === 'object'
                                        ? JSON.stringify(row[column])
                                        : String(row[column])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
