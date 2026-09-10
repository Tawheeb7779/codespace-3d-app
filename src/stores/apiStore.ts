import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { uid } from '@/lib/utils';
import {
  buildRequest,
  redactSecrets,
  sendRequest,
  type ApiRequest,
  type ApiResponse,
  type RequestFailure,
  type Variable,
} from '@/lib/api/request';

/**
 * Saved requests, and the variables that fill them in.
 *
 * **What persists and what does not is the whole security design here.**
 * Requests, headers and variable *names* are saved, because losing a collection
 * on reload would make this useless. Values marked secret are held in memory
 * only: writing an API token to `localStorage` puts it where anything running
 * on the page can read it, and TA CODE's own security scanner flags exactly
 * that in a user's code. Doing it here while flagging it there would be worth
 * nothing.
 *
 * The consequence is stated rather than hidden: after a reload the secret
 * fields are empty and the panel says so, instead of a request that mysteriously
 * starts returning 401.
 */

export interface HistoryEntry {
  id: string;
  requestId: string;
  method: string;
  /** Already redacted: this is stored, and a secret in a URL would be too. */
  url: string;
  status: number | null;
  durationMs: number;
  at: number;
  failure?: string;
}

export type EnvironmentName = 'development' | 'preview' | 'production';

interface ApiState {
  requests: ApiRequest[];
  activeId: string | null;
  /** Variable names and non-secret values, per environment. */
  variables: Record<EnvironmentName, Variable[]>;
  environment: EnvironmentName;
  history: HistoryEntry[];

  running: boolean;
  response: ApiResponse | null;
  failure: RequestFailure | null;

  createRequest: () => string;
  updateRequest: (id: string, patch: Partial<ApiRequest>) => void;
  removeRequest: (id: string) => void;
  select: (id: string) => void;

  setEnvironment: (environment: EnvironmentName) => void;
  setVariables: (environment: EnvironmentName, variables: Variable[]) => void;
  /** The variables in force, for the selected environment. */
  activeVariables: () => Variable[];

  send: () => Promise<void>;
  clearResponse: () => void;
}

const MAX_HISTORY = 50;

function newRequest(index: number): ApiRequest {
  return {
    id: uid('req'),
    name: index === 0 ? 'New request' : `New request ${index + 1}`,
    method: 'GET',
    url: '',
    headers: [],
    params: [],
    body: '',
    auth: { kind: 'none' },
  };
}

const EMPTY_VARIABLES: Record<EnvironmentName, Variable[]> = {
  development: [],
  preview: [],
  production: [],
};

export const useApiStore = create<ApiState>()(
  persist(
    (set, get) => ({
      requests: [],
      activeId: null,
      variables: EMPTY_VARIABLES,
      environment: 'development',
      history: [],
      running: false,
      response: null,
      failure: null,

      createRequest() {
        const request = newRequest(get().requests.length);
        set((state) => ({ requests: [...state.requests, request], activeId: request.id }));
        return request.id;
      },

      updateRequest: (id, patch) =>
        set((state) => ({
          requests: state.requests.map((request) =>
            request.id === id ? { ...request, ...patch } : request,
          ),
        })),

      removeRequest: (id) =>
        set((state) => {
          const requests = state.requests.filter((request) => request.id !== id);
          return {
            requests,
            activeId: state.activeId === id ? (requests[0]?.id ?? null) : state.activeId,
          };
        }),

      select: (id) => set({ activeId: id, response: null, failure: null }),

      setEnvironment: (environment) => set({ environment, response: null, failure: null }),

      setVariables: (environment, variables) =>
        set((state) => ({ variables: { ...state.variables, [environment]: variables } })),

      activeVariables: () => get().variables[get().environment] ?? [],

      async send() {
        const state = get();
        const request = state.requests.find((entry) => entry.id === state.activeId);
        if (!request || state.running) return;

        const variables = state.activeVariables();
        const built = buildRequest(request, variables);
        set({ running: true, response: null, failure: null });

        const result = await sendRequest(built);

        const entry: HistoryEntry = {
          id: uid('hist'),
          requestId: request.id,
          method: built.method,
          // Redacted before it is stored: a token in a query string would
          // otherwise be persisted by the history alone.
          url: redactSecrets(built.url, variables),
          status: result.response?.status ?? null,
          durationMs: result.response?.durationMs ?? 0,
          at: Date.now(),
          failure: result.failure?.message,
        };

        set((current) => ({
          running: false,
          response: result.response ?? null,
          failure: result.failure ?? null,
          history: [entry, ...current.history].slice(0, MAX_HISTORY),
        }));
      },

      clearResponse: () => set({ response: null, failure: null }),
    }),
    {
      name: 'ta-code-api',
      /**
       * Saved: the requests, the collection, and variable names.
       * Never saved: a secret's value, and the response body.
       *
       * A response can contain anything the service returned, including
       * somebody's data; keeping it in browser storage is a copy nobody asked
       * for.
       */
      partialize: (state) => ({
        requests: state.requests,
        activeId: state.activeId,
        environment: state.environment,
        variables: Object.fromEntries(
          Object.entries(state.variables).map(([environment, variables]) => [
            environment,
            variables.map((variable) =>
              variable.secret ? { ...variable, value: '' } : variable,
            ),
          ]),
        ) as Record<EnvironmentName, Variable[]>,
        history: state.history,
      }),
    },
  ),
);
