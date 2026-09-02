import { isSupabaseConfigured } from '@/lib/supabase';
import { localRepository } from '@/lib/repo/localRepository';
import { supabaseRepository } from '@/lib/repo/supabaseRepository';
import type { ProjectRepository } from '@/lib/repo/types';

export type { ProjectRepository } from '@/lib/repo/types';

/**
 * Pick the storage backend for the current session. Local accounts always use
 * the local repository even when Supabase is configured, so signing out of the
 * cloud never strands local work behind an auth wall.
 */
export function repositoryFor(provider: string | undefined): ProjectRepository {
  if (isSupabaseConfigured && provider && provider !== 'local') return supabaseRepository;
  return localRepository;
}

export { localRepository, supabaseRepository };
