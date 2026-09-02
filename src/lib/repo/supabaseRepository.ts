import { requireSupabase } from '@/lib/supabase';
import type { ProjectMeta, ProjectStatus, ProjectVisibility, TemplateId } from '@/types';
import type { Repo } from '@/lib/vcs';
import type { ProjectRepository } from '@/lib/repo/types';

/**
 * Supabase-backed persistence.
 *
 * Every query relies on row level security to scope results — the client never
 * filters by user id for authorization purposes, because a client side filter
 * is not a security control. `owner_id` appears in `listProjects` only as an
 * index hint for the owner's own dashboard view; shared projects arrive through
 * the membership policies.
 */

interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  template: string;
  language: string | null;
  visibility: string;
  status: string;
  starred: boolean;
  dirs: string[] | null;
  created_at: string;
  updated_at: string;
}

const rowToMeta = (row: ProjectRow): ProjectMeta => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  description: row.description ?? '',
  template: row.template as TemplateId,
  language: row.language ?? 'Plain Text',
  visibility: row.visibility as ProjectVisibility,
  status: row.status as ProjectStatus,
  starred: row.starred,
  createdAt: new Date(row.created_at).getTime(),
  updatedAt: new Date(row.updated_at).getTime(),
});

function fail(context: string, error: { message: string; code?: string } | null): never {
  throw new Error(`${context}: ${error?.message ?? 'unknown error'}${error?.code ? ` (${error.code})` : ''}`);
}

export const supabaseRepository: ProjectRepository = {
  kind: 'supabase',

  async listProjects() {
    const client = requireSupabase();
    const { data, error } = await client
      .from('projects')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) fail('Could not load projects', error);
    return (data as ProjectRow[]).map(rowToMeta);
  },

  async getProject(id) {
    const client = requireSupabase();
    const { data, error } = await client.from('projects').select('*').eq('id', id).maybeSingle();
    if (error) fail('Could not load project', error);
    if (!data) return null;
    const { data: fileRows, error: fileError } = await client
      .from('project_files')
      .select('path, content')
      .eq('project_id', id);
    if (fileError) fail('Could not load project files', fileError);
    const files: Record<string, string> = {};
    for (const row of (fileRows ?? []) as Array<{ path: string; content: string }>) {
      files[row.path] = row.content;
    }
    const row = data as ProjectRow;
    return { ...rowToMeta(row), files, dirs: row.dirs ?? [] };
  },

  async createProject(project) {
    const client = requireSupabase();
    const { data, error } = await client
      .from('projects')
      .insert({
        id: project.id,
        owner_id: project.ownerId,
        name: project.name,
        description: project.description,
        template: project.template,
        language: project.language,
        visibility: project.visibility,
        status: project.status,
        starred: project.starred,
        dirs: project.dirs,
      })
      .select()
      .single();
    if (error) fail('Could not create project', error);

    const rows = Object.entries(project.files).map(([path, content]) => ({
      project_id: project.id,
      path,
      content,
    }));
    if (rows.length) {
      const { error: fileError } = await client.from('project_files').insert(rows);
      if (fileError) fail('Could not write project files', fileError);
    }
    return { ...rowToMeta(data as ProjectRow), files: project.files, dirs: project.dirs };
  },

  async updateProject(id, patch) {
    const client = requireSupabase();
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.starred !== undefined) row.starred = patch.starred;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.visibility !== undefined) row.visibility = patch.visibility;
    if (patch.language !== undefined) row.language = patch.language;
    const { error } = await client.from('projects').update(row).eq('id', id);
    if (error) fail('Could not update project', error);
  },

  async saveFiles(id, files, dirs) {
    const client = requireSupabase();
    const { data: existing, error: readError } = await client
      .from('project_files')
      .select('path')
      .eq('project_id', id);
    if (readError) fail('Could not read existing files', readError);

    const known = new Set((existing ?? []).map((r) => (r as { path: string }).path));
    const nextPaths = new Set(Object.keys(files));
    const removed = [...known].filter((p) => !nextPaths.has(p));

    if (removed.length) {
      const { error } = await client
        .from('project_files')
        .delete()
        .eq('project_id', id)
        .in('path', removed);
      if (error) fail('Could not delete removed files', error);
    }

    const rows = Object.entries(files).map(([path, content]) => ({
      project_id: id,
      path,
      content,
      updated_at: new Date().toISOString(),
    }));
    if (rows.length) {
      const { error } = await client
        .from('project_files')
        .upsert(rows, { onConflict: 'project_id,path' });
      if (error) fail('Could not save files', error);
    }

    const { error: metaError } = await client
      .from('projects')
      .update({ dirs, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (metaError) fail('Could not update project metadata', metaError);
  },

  async deleteProject(id) {
    const client = requireSupabase();
    // project_files and project_vcs cascade from the projects row.
    const { error } = await client.from('projects').delete().eq('id', id);
    if (error) fail('Could not delete project', error);
  },

  async loadVcs(id) {
    const client = requireSupabase();
    const { data, error } = await client
      .from('project_vcs')
      .select('snapshot')
      .eq('project_id', id)
      .maybeSingle();
    if (error) fail('Could not load version history', error);
    return (data?.snapshot as Repo | undefined) ?? null;
  },

  async saveVcs(id, repo) {
    const client = requireSupabase();
    const { error } = await client
      .from('project_vcs')
      .upsert({ project_id: id, snapshot: repo, updated_at: new Date().toISOString() });
    if (error) fail('Could not save version history', error);
  },

  /**
   * The remote lives in its own table so row level security can treat it
   * separately: reading it needs membership, connecting it needs admin, and
   * recording a push needs write access. The commit-to-SHA map and the synced
   * tree ride along in `project_vcs`, since they are local bookkeeping rather
   * than shared configuration.
   */
  async loadRemote(id) {
    const client = requireSupabase();
    const { data, error } = await client
      .from('project_remotes')
      .select('owner, repo, repo_id, default_branch, branch, last_fetched_sha, last_synced_sha, last_fetched_at, tracking')
      .eq('project_id', id)
      .maybeSingle();
    if (error) fail('Could not load the connected repository', error);
    if (!data) return null;
    const tracking = (data.tracking ?? {}) as {
      syncedTree?: Record<string, string> | null;
      pushedUpTo?: string | null;
      merging?: { sha: string; tree: Record<string, string> } | null;
      commitShas?: Record<string, string>;
    };
    return {
      provider: 'github',
      owner: data.owner as string,
      repo: data.repo as string,
      repoId: Number(data.repo_id),
      defaultBranch: data.default_branch as string,
      branch: data.branch as string,
      lastFetchedSha: (data.last_fetched_sha as string | null) ?? null,
      lastSyncedSha: (data.last_synced_sha as string | null) ?? null,
      lastFetchedAt: data.last_fetched_at ? Date.parse(data.last_fetched_at as string) : null,
      syncedTree: tracking.syncedTree ?? null,
      pushedUpTo: tracking.pushedUpTo ?? null,
      merging: tracking.merging ?? null,
      commitShas: tracking.commitShas ?? {},
    };
  },

  async saveRemote(id, remote) {
    const client = requireSupabase();
    const { error } = await client.from('project_remotes').upsert({
      project_id: id,
      provider: remote.provider,
      owner: remote.owner,
      repo: remote.repo,
      repo_id: remote.repoId,
      default_branch: remote.defaultBranch,
      branch: remote.branch,
      last_fetched_sha: remote.lastFetchedSha,
      last_synced_sha: remote.lastSyncedSha,
      last_fetched_at: remote.lastFetchedAt ? new Date(remote.lastFetchedAt).toISOString() : null,
      tracking: {
        syncedTree: remote.syncedTree,
        pushedUpTo: remote.pushedUpTo,
        merging: remote.merging,
        commitShas: remote.commitShas,
      },
      updated_at: new Date().toISOString(),
    });
    if (error) fail('Could not save the connected repository', error);
  },

  async clearRemote(id) {
    const client = requireSupabase();
    const { error } = await client.from('project_remotes').delete().eq('project_id', id);
    if (error) fail('Could not disconnect the repository', error);
  },
};
