/**
 * Minimal promise wrapper over IndexedDB.
 *
 * Projects can hold hundreds of files; localStorage's ~5 MB string budget is
 * too small and its writes are synchronous. IndexedDB gives us room and keeps
 * the main thread free. When IndexedDB is unavailable (private mode, older
 * embedded webviews) the store falls back to an in-memory map so the app still
 * runs — it just cannot persist, and the UI says so.
 */

const DB_NAME = 'forge-ide';
const DB_VERSION = 1;

export type StoreName = 'projects' | 'repos' | 'kv';
const STORES: StoreName[] = ['projects', 'repos', 'kv'];

let dbPromise: Promise<IDBDatabase> | null = null;
let unavailableReason: string | null = null;
const memory = new Map<string, Map<string, unknown>>();

function memoryStore(name: StoreName): Map<string, unknown> {
  let store = memory.get(name);
  if (!store) {
    store = new Map();
    memory.set(name, store);
  }
  return store;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser context'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  return dbPromise;
}

/** True once a persistence failure has been observed. */
export function persistenceStatus(): { ok: boolean; reason: string | null } {
  return { ok: unavailableReason === null, reason: unavailableReason };
}

async function withStore<T>(
  name: StoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const request = run(tx.objectStore(name));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  try {
    return await withStore<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
    return memoryStore(store).get(key) as T | undefined;
  }
}

/** True when IndexedDB itself could not be opened, as opposed to a failed write. */
async function databaseUnavailable(): Promise<boolean> {
  try {
    await openDb();
    return false;
  } catch {
    return true;
  }
}

export async function idbSet(store: StoreName, key: string, value: unknown): Promise<void> {
  try {
    await withStore(store, 'readwrite', (s) => s.put(value, key) as IDBRequest<IDBValidKey>);
    memoryStore(store).set(key, value);
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
    memoryStore(store).set(key, value);
    // No IndexedDB at all (private mode, an embedded webview, a test runner) is
    // the documented degraded mode: keep the value in memory and let the UI
    // report that persistence is off. A write that fails on a *working*
    // database — quota exceeded, for instance — is a real failure and must
    // reach the caller so it can be retried or reported.
    if (await databaseUnavailable()) return;
    throw error;
  }
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  memoryStore(store).delete(key);
  try {
    await withStore(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
  }
}

export async function idbAll<T>(store: StoreName): Promise<T[]> {
  try {
    return await withStore<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
    return [...memoryStore(store).values()] as T[];
  }
}
