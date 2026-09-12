import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { Input, Select } from '@/components/ui/Field';
import { Badge, EmptyState, ErrorState, Spinner } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { ProviderError } from '@/lib/ai/provider';
import { supportsDiscovery, type ProviderRecord } from '@/lib/ai/providers';
import {
  discoverModelsCached,
  filterModels,
  type CostClass,
  type ModelRecord,
} from '@/lib/ai/modelDiscovery';
import { cx } from '@/lib/utils';

/**
 * Choosing a model from what the provider actually offers.
 *
 * This replaces a text box. The box was the honest thing to ship when nothing
 * knew what models existed, but it put the burden of remembering exact ids on
 * the user and failed at the worst moment — a name that had been deprecated
 * came back as a 404 partway through a task.
 *
 * Every row here came from the provider's own model list. Nothing is offered
 * that the provider did not return, and the fields the provider left out are
 * shown as unknown rather than filled in with something plausible: a context
 * window nobody stated is worse than no number, because it reads as a fact.
 *
 * A provider that publishes no list keeps the text box, and says why.
 */

const COST_LABEL: Record<CostClass, string> = {
  free: 'Free',
  'free-tier': 'Free tier',
  paid: 'Paid',
  unknown: 'Price unknown',
};

const COST_TONE: Record<CostClass, 'positive' | 'accent' | 'neutral'> = {
  free: 'positive',
  // Deliberately not `positive`: an allowance is not the same promise as a
  // price of zero, and the two must not read alike.
  'free-tier': 'accent',
  paid: 'neutral',
  unknown: 'neutral',
};

/**
 * Compact enough for a row, and only ever shown when a number was supplied.
 *
 * Divided by 1024 rather than 1000 because context windows are powers of two
 * and are quoted that way: 32768 is the number every provider calls 32K, and
 * rounding it decimally would print 33K next to their own documentation.
 */
function formatContext(tokens: number): string {
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K context`;
  return `${tokens} context`;
}

export interface ModelPickerProps {
  provider: ProviderRecord;
  /** Overrides the record's base URL, for a proxy or a local server. */
  baseUrl?: string;
  apiKey?: string;
  /** The model currently configured, which may not be in the list. */
  selected: string;
  onSelect: (modelId: string) => void;
}

export function ModelPicker({
  provider,
  baseUrl,
  apiKey,
  selected,
  onSelect,
}: ModelPickerProps) {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ message: string; kind: string } | null>(null);
  const [query, setQuery] = useState('');
  const [cost, setCost] = useState<'all' | CostClass>('all');
  const [toolsOnly, setToolsOnly] = useState(false);

  const canDiscover = supportsDiscovery(provider);
  const needsKey = provider.requiresUserApiKey && !apiKey;
  const endpoint = (baseUrl ?? provider.baseUrl).trim();

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setFailure(null);
      try {
        const result = await discoverModelsCached({ provider, baseUrl, apiKey, refresh });
        setModels(result.models);
      } catch (error) {
        // Shown as the provider's own refusal rather than swallowed: a list
        // that failed to load is not an account with no models.
        const problem =
          error instanceof ProviderError
            ? { message: error.message, kind: error.kind }
            : { message: 'Could not list models.', kind: 'request' };
        setFailure(problem);
        setModels([]);
      } finally {
        setLoading(false);
      }
    },
    [provider, baseUrl, apiKey],
  );

  useEffect(() => {
    if (!canDiscover || needsKey || !endpoint) {
      setModels([]);
      setFailure(null);
      return;
    }
    void load(false);
  }, [canDiscover, needsKey, endpoint, load]);

  const visible = useMemo(
    () =>
      filterModels(models, {
        query,
        cost: cost === 'all' ? undefined : [cost],
        toolCallingOnly: toolsOnly,
      }),
    [models, query, cost, toolsOnly],
  );

  // A provider with no list is not a broken provider. Say which it is and keep
  // the field that does work for it.
  if (!canDiscover) {
    return (
      <div className="space-y-2">
        <Input
          label="Model"
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
          hint={`${provider.label} does not publish a model list, so the model is entered by hand.`}
        />
      </div>
    );
  }

  if (needsKey) {
    return (
      <EmptyState
        title="Add a key to see the models"
        description={`${provider.label} lists its models to an authenticated caller. ${provider.accessNote}`}
      />
    );
  }

  if (!endpoint) {
    return (
      <EmptyState
        title="Set a base URL to see the models"
        description="A base URL is needed before this endpoint can be asked what it offers."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <Input
          label="Model"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the provider's models"
          leading={<Search aria-hidden className="h-3.5 w-3.5" />}
          className="flex-1"
        />
        <IconButton
          label="Ask the provider again"
          onClick={() => void load(true)}
          disabled={loading}
          icon={<RefreshCw aria-hidden className={cx('h-4 w-4', loading && 'animate-spin')} />}
        />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Select
          label="Cost"
          value={cost}
          onChange={(event) => setCost(event.target.value as 'all' | CostClass)}
          options={[
            { value: 'all', label: 'Any cost' },
            { value: 'free', label: COST_LABEL.free },
            { value: 'free-tier', label: COST_LABEL['free-tier'] },
            { value: 'paid', label: COST_LABEL.paid },
            { value: 'unknown', label: COST_LABEL.unknown },
          ]}
        />
        <label className="tap-target flex items-center gap-2 pb-1 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={toolsOnly}
            onChange={(event) => setToolsOnly(event.target.checked)}
            className="accent-accent"
          />
          <span>Hide models that cannot call tools</span>
        </label>
      </div>

      {loading && models.length === 0 && (
        <div className="flex items-center gap-2 p-4 text-xs text-ink-muted">
          <Spinner />
          <span>Asking {provider.label} what it offers…</span>
        </div>
      )}

      {failure && (
        <ErrorState
          title="Could not list models"
          detail={failure.message}
          onRetry={() => void load(true)}
          retryLabel="Try again"
        />
      )}

      {!loading && !failure && models.length === 0 && (
        <EmptyState
          title="This provider returned no models"
          description={`${provider.label} answered, and its list was empty. Nothing is shown, because nothing was offered.`}
        />
      )}

      {visible.length > 0 && (
        <ul
          className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line bg-surface-sunken"
          aria-label={`Models offered by ${provider.label}`}
        >
          {visible.map((model) => {
            const active = model.modelId === selected;
            return (
              <li key={model.modelId}>
                <button
                  type="button"
                  onClick={() => onSelect(model.modelId)}
                  aria-current={active ? 'true' : undefined}
                  className={cx(
                    'flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors',
                    active ? 'bg-accent-soft' : 'hover:bg-surface-raised',
                  )}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-ink">{model.modelId}</span>
                    <Badge tone={COST_TONE[model.cost]}>{COST_LABEL[model.cost]}</Badge>
                    {!model.available && <Badge tone="danger">Unavailable</Badge>}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-2xs text-ink-faint">
                    {model.displayName !== model.modelId && <span>{model.displayName}</span>}
                    {model.contextLength !== null && (
                      <span className="tabular-nums">{formatContext(model.contextLength)}</span>
                    )}
                    <span>
                      {model.toolCalling === null
                        ? 'Tool support not stated'
                        : model.toolCalling
                          ? 'Calls tools'
                          : 'No tool calling'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {models.length > 0 && visible.length === 0 && (
        <EmptyState
          title="No model matches those filters"
          description={`${provider.label} offered ${models.length} model${models.length === 1 ? '' : 's'}, and none of them match.`}
        />
      )}

      {models.length > 0 && (
        <p className="text-2xs text-ink-faint">
          <span>
            {models.length} model{models.length === 1 ? '' : 's'} from {provider.label}.{' '}
            {provider.accessNote}
          </span>
        </p>
      )}
    </div>
  );
}
