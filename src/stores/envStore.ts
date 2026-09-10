import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  ENVIRONMENTS,
  needsConfirmation,
  type EnvVariable,
  type EnvironmentId,
} from '@/lib/env/manager';

/**
 * Which variables each environment declares.
 *
 * **Secret values are not stored, and there is no code path that could store
 * one.** `setValue` refuses when the variable is marked secret, rather than
 * relying on the panel to hide a field — a store that will happily hold a
 * production credential is one keystroke from holding one. What is kept is the
 * name, which environments need it, whether it is secret, and a note; that is
 * the part a browser can hold honestly.
 *
 * **Production is guarded.** A change to production goes through `commit`,
 * which refuses without an explicit confirmation. The guard is only on
 * production: a confirmation on every environment becomes a reflex, and the
 * reflex is what makes the production one useless.
 */

interface PendingChange {
  environment: EnvironmentId;
  description: string;
  apply: () => void;
}

interface EnvState {
  variables: EnvVariable[];
  environment: EnvironmentId;
  /** A production change waiting to be confirmed. */
  pending: PendingChange | null;

  setEnvironment: (environment: EnvironmentId) => void;
  addVariable: (key: string) => void;
  removeVariable: (key: string) => void;
  toggleEnvironment: (key: string, environment: EnvironmentId) => void;
  setSecret: (key: string, secret: boolean) => void;
  setNote: (key: string, note: string) => void;
  /** Refused for a secret variable. Returns whether it was applied. */
  setValue: (key: string, value: string) => boolean;
  /** Run a change, asking first when the environment is production. */
  guarded: (description: string, apply: () => void) => void;
  confirmPending: () => void;
  cancelPending: () => void;
}

export const useEnvStore = create<EnvState>()(
  persist(
    (set, get) => ({
      variables: [],
      environment: 'development',
      pending: null,

      setEnvironment: (environment) => set({ environment, pending: null }),

      addVariable: (key) => {
        const clean = key.trim();
        if (!clean || get().variables.some((variable) => variable.key === clean)) return;
        set((state) => ({
          variables: [
            ...state.variables,
            {
              key: clean,
              // Declared for the environment being looked at, not for all three:
              // assuming production needs it is how a value goes missing there
              // without anybody being told.
              environments: [state.environment],
              secret: false,
              value: '',
              note: '',
            },
          ],
        }));
      },

      removeVariable: (key) =>
        set((state) => ({ variables: state.variables.filter((variable) => variable.key !== key) })),

      toggleEnvironment: (key, environment) =>
        set((state) => ({
          variables: state.variables.map((variable) =>
            variable.key === key
              ? {
                  ...variable,
                  environments: variable.environments.includes(environment)
                    ? variable.environments.filter((entry) => entry !== environment)
                    : [...variable.environments, environment].filter((entry) =>
                        ENVIRONMENTS.includes(entry),
                      ),
                }
              : variable,
          ),
        })),

      setSecret: (key, secret) =>
        set((state) => ({
          variables: state.variables.map((variable) =>
            variable.key === key
              ? // Marking it secret drops whatever value was there. Keeping it
                // would leave a credential in storage under a label that says
                // it is not stored.
                { ...variable, secret, value: secret ? '' : variable.value }
              : variable,
          ),
        })),

      setNote: (key, note) =>
        set((state) => ({
          variables: state.variables.map((variable) =>
            variable.key === key ? { ...variable, note: note.slice(0, 200) } : variable,
          ),
        })),

      setValue: (key, value) => {
        const variable = get().variables.find((entry) => entry.key === key);
        // The refusal that makes the promise real, rather than a hidden field.
        if (!variable || variable.secret) return false;
        set((state) => ({
          variables: state.variables.map((entry) =>
            entry.key === key ? { ...entry, value } : entry,
          ),
        }));
        return true;
      },

      guarded: (description, apply) => {
        if (!needsConfirmation(get().environment)) {
          apply();
          return;
        }
        set({ pending: { environment: get().environment, description, apply } });
      },

      confirmPending: () => {
        const pending = get().pending;
        if (!pending) return;
        set({ pending: null });
        pending.apply();
      },

      cancelPending: () => set({ pending: null }),
    }),
    {
      name: 'ta-code-environments',
      /**
       * Names, environments, notes and non-secret values.
       *
       * `value` is stripped for anything marked secret on the way out as well.
       * `setValue` already refuses, so this is the second lock on the same
       * door — cheap, and the kind of thing that matters when somebody later
       * adds a third way to set a value.
       */
      partialize: (state) => ({
        environment: state.environment,
        variables: state.variables.map((variable) =>
          variable.secret ? { ...variable, value: '' } : variable,
        ),
      }),
    },
  ),
);
