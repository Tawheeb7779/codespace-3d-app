import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  censusWarning,
  censusWorkspaces,
  isCurrentWorkspaceId,
  isLegacyWorkspaceId,
  legacyContainerIdFor,
  migrateWorkspace,
} from '../src/migration.ts';
import { containerIdFor } from '../src/lifecycle.ts';

/**
 * Workspaces stranded by the container-id change.
 *
 * The tests that matter here are the refusals. Moving a directory to the right
 * place is easy; the reason this is a module rather than a one-line `mv` is
 * that the old id was a one-way 32-bit hash which collided on purpose, so
 * "which user owns this directory" has no answer — and a migration that guesses
 * would hand one user another's files, which is the exposure the id change
 * closed.
 */

const USER = '8f14e45f-ceea-467a-9b8a-1c2d3e4f5a6b';
const PROJECT = 'prj_alpha';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tacode-migrate-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A legacy workspace for a pair, with a file in it worth not losing. */
async function seedLegacy(userId = USER, projectId = PROJECT): Promise<string> {
  const id = legacyContainerIdFor(userId, projectId);
  await mkdir(join(root, id, 'src'), { recursive: true });
  await writeFile(join(root, id, 'src', 'app.ts'), 'export const kept = true;\n');
  return id;
}

describe('telling the two id formats apart', () => {
  it('recognises the old eight-hex name', () => {
    expect(isLegacyWorkspaceId('tacode-10847e1b')).toBe(true);
    expect(isCurrentWorkspaceId('tacode-10847e1b')).toBe(false);
  });

  it('recognises the current thirty-two-hex name', () => {
    const id = containerIdFor(USER, PROJECT);

    expect(isCurrentWorkspaceId(id)).toBe(true);
    expect(isLegacyWorkspaceId(id)).toBe(false);
  });

  it.each(['tacode-', 'tacode-zzzzzzzz', 'tacode-10847e1', 'notacode-10847e1b', '..', 'tmp'])(
    'treats %s as neither',
    (name) => {
      expect(isLegacyWorkspaceId(name)).toBe(false);
      expect(isCurrentWorkspaceId(name)).toBe(false);
    },
  );
});

describe('taking a census of the workspace root', () => {
  it('separates legacy, current and everything else', async () => {
    await seedLegacy();
    await mkdir(join(root, containerIdFor(USER, 'prj_beta')), { recursive: true });
    await mkdir(join(root, 'some-other-thing'), { recursive: true });
    await writeFile(join(root, 'notes.txt'), 'a file, not a workspace\n');

    const census = await censusWorkspaces(root);

    expect(census.legacy).toHaveLength(1);
    expect(census.current).toHaveLength(1);
    expect(census.unknown.sort()).toEqual(['notes.txt', 'some-other-thing']);
  });

  /**
   * A symlink in the workspace root must never be classified as a workspace:
   * migrating one would `rename` a link and, worse, invite the caller to treat
   * whatever it points at as project files.
   */
  it('never classifies a symlink as a workspace', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, 'tacode-10847e1b'));

    const census = await censusWorkspaces(root);

    expect(census.legacy).toEqual([]);
    expect(census.unknown).toContain('tacode-10847e1b');
  });

  it('is empty and quiet for a root with nothing in it', async () => {
    const census = await censusWorkspaces(root);

    expect(census).toEqual({ legacy: [], current: [], unknown: [] });
    expect(censusWarning(census)).toBeNull();
  });

  it('says something an operator can act on when workspaces are stranded', async () => {
    await seedLegacy();

    const warning = censusWarning(await censusWorkspaces(root));

    expect(warning).toMatch(/1 workspace directory uses/);
    expect(warning).toMatch(/untouched/);
  });

  it('does not fall over on a root that does not exist', async () => {
    const census = await censusWorkspaces(join(root, 'nope'));

    expect(census.legacy).toEqual([]);
  });
});

describe('migrating one workspace', () => {
  it('moves it to the name its pair uses now, keeping the files', async () => {
    const legacy = await seedLegacy();
    const current = containerIdFor(USER, PROJECT);

    const outcome = await migrateWorkspace(root, USER, PROJECT);

    expect(outcome).toEqual({ status: 'migrated', from: legacy, to: current });
    expect(await readFile(join(root, current, 'src', 'app.ts'), 'utf8')).toBe(
      'export const kept = true;\n',
    );
    // Moved, not copied: the old name is gone rather than left as a duplicate
    // that a future census would report forever.
    expect(await readdir(root)).toEqual([current]);
  });

  it('is idempotent: running it again reports there is nothing left to do', async () => {
    await seedLegacy();

    const first = await migrateWorkspace(root, USER, PROJECT);
    const second = await migrateWorkspace(root, USER, PROJECT);

    expect(first.status).toBe('migrated');
    expect(second.status).toBe('already-migrated');
  });

  it('says nothing to do when the pair never had a legacy workspace', async () => {
    const outcome = await migrateWorkspace(root, USER, 'prj_never_existed');

    expect(outcome.status).toBe('nothing-to-do');
  });

  /**
   * The refusal that matters most. Both directories having content means two
   * workspaces exist for one pair — the container was started since the id
   * changed, and files accumulated under the new name. A rename here would
   * either fail or merge two sets of project files, and merging is a silent
   * loss of whichever version the person needed.
   */
  it('refuses rather than merging into a workspace that has content', async () => {
    await seedLegacy();
    const current = containerIdFor(USER, PROJECT);
    await mkdir(join(root, current), { recursive: true });
    await writeFile(join(root, current, 'newer.ts'), 'written since the id changed\n');

    const outcome = await migrateWorkspace(root, USER, PROJECT);

    expect(outcome.status).toBe('refused');
    expect(outcome).toHaveProperty('reason', expect.stringMatching(/merge two workspaces/));
    // Both sides survive untouched, so a person can reconcile them by hand.
    expect(await readFile(join(root, current, 'newer.ts'), 'utf8')).toBe(
      'written since the id changed\n',
    );
    expect(
      await readFile(join(root, legacyContainerIdFor(USER, PROJECT), 'src', 'app.ts'), 'utf8'),
    ).toBe('export const kept = true;\n');
  });

  it('migrates into an empty directory left by a container that already started', async () => {
    await seedLegacy();
    const current = containerIdFor(USER, PROJECT);
    await mkdir(join(root, current), { recursive: true });

    const outcome = await migrateWorkspace(root, USER, PROJECT);

    expect(outcome.status).toBe('migrated');
    expect(await readFile(join(root, current, 'src', 'app.ts'), 'utf8')).toBe(
      'export const kept = true;\n',
    );
  });

  it('changes nothing under --dry-run', async () => {
    const legacy = await seedLegacy();

    const outcome = await migrateWorkspace(root, USER, PROJECT, { dryRun: true });

    expect(outcome.status).toBe('migrated');
    // Still where it was: a dry run that moved things would be a trap.
    expect(await readdir(root)).toEqual([legacy]);
  });
});

describe('the wrong owner', () => {
  /**
   * The security property, stated directly.
   *
   * A migration is only ever addressed by `(user, project)`, and both ids are
   * derived from that pair inside the function. So naming somebody else's pair
   * cannot reach a directory that is not theirs by that derivation — and,
   * critically, a *different* pair simply computes a different legacy name and
   * finds nothing.
   */
  it('cannot move another pair’s workspace by asking for it', async () => {
    const legacy = await seedLegacy(USER, PROJECT);

    // A different user, and a different project. Neither derives the seeded
    // directory's name.
    const outcome = await migrateWorkspace(root, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'prj_mine');

    expect(outcome.status).toBe('nothing-to-do');
    expect(await readdir(root)).toEqual([legacy]);
  });

  /**
   * The collision the id change existed to fix, as a migration hazard.
   *
   * Two pairs that hashed alike under the old scheme name the *same* legacy
   * directory, so whichever pair is migrated first takes it. There is no way to
   * tell from disk which one is the rightful owner — which is exactly why this
   * is operator-driven and never automatic. The test records the behaviour
   * honestly rather than pretending it is resolved: the second pair finds
   * nothing, and no data is duplicated or leaked into a third place.
   */
  it('gives a colliding legacy directory to whoever is migrated first, and only once', async () => {
    const victimUser = '8f14e45f-ceea-467a-9b8a-1c2d3e4f5a6b';
    const victimProject = 'prj_m1x2y3z4a1b2c3d4';
    const attackerUser = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const attackerProject = 'prj_2yvxr6';

    // These two pairs collided under the old 32-bit hash. That is the bug.
    expect(legacyContainerIdFor(attackerUser, attackerProject)).toBe(
      legacyContainerIdFor(victimUser, victimProject),
    );
    // And they do not collide now, which is the fix.
    expect(containerIdFor(attackerUser, attackerProject)).not.toBe(
      containerIdFor(victimUser, victimProject),
    );

    await seedLegacy(victimUser, victimProject);

    const first = await migrateWorkspace(root, victimUser, victimProject);
    const second = await migrateWorkspace(root, attackerUser, attackerProject);

    expect(first.status).toBe('migrated');
    // The directory is gone, so the colliding pair gets nothing — no copy, no
    // second workspace holding the same files.
    expect(second.status).toBe('nothing-to-do');
    expect(await readdir(root)).toEqual([containerIdFor(victimUser, victimProject)]);
  });
});

describe('what the legacy id function is for', () => {
  it('reproduces the old hash exactly, or a stranded workspace cannot be found', () => {
    // The value the old implementation produced for this pair, recorded so a
    // refactor cannot quietly change it and make every legacy directory
    // unreachable.
    expect(legacyContainerIdFor('8f14e45f-ceea-467a-9b8a-1c2d3e4f5a6b', 'prj_m1x2y3z4a1b2c3d4')).toBe(
      'tacode-10847e1b',
    );
  });

  it('is never what a new workspace is named', () => {
    expect(legacyContainerIdFor(USER, PROJECT)).not.toBe(containerIdFor(USER, PROJECT));
  });
});
