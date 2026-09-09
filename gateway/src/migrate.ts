import { loadConfig } from './config.ts';
import { censusWorkspaces, migrateWorkspace, legacyContainerIdFor } from './migration.ts';
import { containerIdFor } from './lifecycle.ts';

/**
 * The workspace migration tool.
 *
 *   npm run migrate:workspaces -- --list
 *   npm run migrate:workspaces -- --user <uuid> --project <id> [--dry-run]
 *
 * Two commands, because migration is two jobs done by two different people.
 * `--list` says what is stranded, which the gateway also reports at boot.
 * Migrating one workspace needs the `(user, project)` pair, and supplying it is
 * the ownership claim — the old id is a one-way 32-bit hash that collided by
 * design, so nothing on disk or in the database can establish who a legacy
 * directory belongs to. A person decides, one project at a time.
 *
 * Nothing here deletes. The worst outcome of running it wrongly is a refusal.
 */

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const config = loadConfig();
const root = config.workspaceRoot;

if (process.argv.includes('--list') || process.argv.length <= 2) {
  const census = await censusWorkspaces(root);
  console.log(`workspace root: ${root}`);
  console.log(`current-format workspaces: ${census.current.length}`);
  console.log(`legacy-format workspaces:  ${census.legacy.length}`);
  if (census.unknown.length) {
    console.log(`unrecognised entries:      ${census.unknown.length} (left alone)`);
  }
  for (const name of census.legacy) console.log(`  legacy  ${name}`);
  if (census.legacy.length) {
    console.log('');
    console.log('These belong to nobody the gateway can identify: the old id is a');
    console.log('one-way hash and no record ties it to a user. To migrate one, name');
    console.log('the pair it belongs to:');
    console.log('');
    console.log('  npm run migrate:workspaces -- --user <uuid> --project <id> --dry-run');
    console.log('');
    console.log('Verify the reported legacy id matches the directory, then re-run');
    console.log('without --dry-run.');
  }
  process.exit(0);
}

const userId = arg('user');
const projectId = arg('project');
const dryRun = process.argv.includes('--dry-run');

if (!userId || !projectId) {
  console.error('Both --user and --project are required. Use --list to see what is stranded.');
  process.exit(2);
}

console.log(`workspace root: ${root}`);
console.log(`legacy id:      ${legacyContainerIdFor(userId, projectId)}`);
console.log(`current id:     ${containerIdFor(userId, projectId)}`);

const outcome = await migrateWorkspace(root, userId, projectId, { dryRun });

switch (outcome.status) {
  case 'migrated':
    console.log(dryRun ? 'would migrate: yes' : `migrated ${outcome.from} -> ${outcome.to}`);
    break;
  case 'already-migrated':
    console.log('already migrated; nothing to do');
    break;
  case 'nothing-to-do':
    console.log('no legacy workspace exists for that pair');
    break;
  case 'refused':
    console.error(`refused: ${outcome.reason}`);
    process.exit(1);
}
