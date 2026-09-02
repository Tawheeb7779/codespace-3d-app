import type { ShellHost, ShellLine } from '@/lib/shell';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useGitStore } from '@/stores/gitStore';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { addDependency, listInstalled, removeDependency } from '@/lib/packages';
import { downloadBlob, exportZip, safeArchiveName } from '@/lib/archive';
import { buildPreview } from '@/lib/preview';
import { errorMessage } from '@/lib/utils';
import { basename, joinPath } from '@/lib/vfs';

const out = (text: string): ShellLine => ({ kind: 'stdout', text });
const err = (text: string): ShellLine => ({ kind: 'stderr', text });
const info = (text: string): ShellLine => ({ kind: 'info', text });

/**
 * Binds the shell interpreter to live application state. Kept out of the
 * interpreter itself so `lib/shell.ts` stays pure and unit testable.
 */
export function createShellHost(): ShellHost {
  const files = () => useFileStore.getState();

  return {
    get projectName() {
      return useFileStore.getState().meta?.name ?? 'untitled';
    },
    get user() {
      const user = useAuthStore.getState().user;
      return user ? `${user.displayName} <${user.email}>` : 'anonymous';
    },

    getFiles: () => files().files,
    getDirs: () => files().dirs,
    writeFile: (path, content) => {
      const store = files();
      if (path in store.files) store.writeFile(path, content);
      else store.createFile(path, content);
    },
    removePath: (path) => {
      files().remove(path);
      useEditorStore.getState().removePath(path);
    },
    makeDir: (path) => files().createDir(path),
    movePath: (from, to) => {
      const next = files().rename(from, to);
      useEditorStore.getState().renamePath(from, next);
    },
    openInEditor: (path) => {
      useEditorStore.getState().openTab(path);
      useUIStore.getState().setMobilePane('editor');
    },

    async build() {
      const result = await buildPreview(files().files);
      if (!result.entry) return [err('build: no entry point found (index.html or src/main.*)')];
      if (result.errors.length) {
        return [
          err(`build failed with ${result.errors.length} error(s):`),
          ...result.errors.map((e) => err(`  ${e.path}:${e.line}:${e.column} ${e.message}`)),
        ];
      }
      return [
        info(`built ${result.entry} in ${result.durationMs}ms`),
        ...result.warnings.map((w) => out(`  warning ${w.path}:${w.line} ${w.message}`)),
        ...(result.externals.length
          ? [out(`  external packages resolved via esm.sh: ${result.externals.join(', ')}`)]
          : []),
      ];
    },

    async startPreview() {
      await usePreviewStore.getState().run();
      const { status, entry, errors, lastBuildMs } = usePreviewStore.getState();
      useUIStore.getState().togglePreview(true);
      if (status === 'error') {
        return [
          err(`preview failed to start (${errors.length} build error(s))`),
          ...errors.slice(0, 10).map((e) => err(`  ${e.path}:${e.line} ${e.message}`)),
        ];
      }
      return [info(`preview running — ${entry} built in ${lastBuildMs}ms`)];
    },

    stopPreview() {
      usePreviewStore.getState().stop();
      return [info('preview stopped')];
    },

    async npm(args) {
      const store = files();
      const manifestPath = 'package.json';
      const sub = args[0];

      if (!sub || sub === 'ls' || sub === 'list') {
        const installed = listInstalled(store.files[manifestPath]);
        if (!installed.length) return [info('no dependencies declared in package.json')];
        return [
          info('Declared dependencies (resolved at preview time from esm.sh):'),
          ...installed.map((p) => out(`  ${p.name}@${p.version}${p.dev ? '  (dev)' : ''}`)),
        ];
      }

      if (sub === 'install' || sub === 'i' || sub === 'add') {
        const dev = args.includes('--save-dev') || args.includes('-D');
        const specs = args.slice(1).filter((a) => !a.startsWith('-'));
        if (!specs.length) {
          return [
            err('npm install without arguments cannot run here: there is no node_modules to populate.'),
            info('Install a specific package instead, e.g. "npm install zustand".'),
          ];
        }
        const lines: ShellLine[] = [];
        for (const spec of specs) {
          try {
            const result = await addDependency(store.files[manifestPath], spec, dev);
            if (manifestPath in store.files) store.writeFile(manifestPath, result.manifest);
            else store.createFile(manifestPath, result.manifest);
            lines.push(out(`+ ${result.name}@${result.version}`));
          } catch (error) {
            lines.push(err(`npm: ${errorMessage(error)}`));
          }
        }
        lines.push(info('package.json updated. The preview loads these from esm.sh on next run.'));
        return lines;
      }

      if (sub === 'uninstall' || sub === 'remove' || sub === 'rm') {
        const names = args.slice(1).filter((a) => !a.startsWith('-'));
        if (!names.length) return [err('npm uninstall: specify at least one package')];
        const lines: ShellLine[] = [];
        for (const name of names) {
          try {
            store.writeFile(manifestPath, removeDependency(store.files[manifestPath], name));
            lines.push(out(`- ${name}`));
          } catch (error) {
            lines.push(err(`npm: ${errorMessage(error)}`));
          }
        }
        return lines;
      }

      if (sub === 'run') {
        return [
          err('npm run is not available: there is no Node process in the browser.'),
          info('Use "build" to bundle the project or "run" to start the live preview.'),
        ];
      }

      return [err(`npm: unsupported subcommand "${sub}". Supported: install, uninstall, ls.`)];
    },

    git: (args) => useGitStore.getState().runCommand(args),

    async exportArchive() {
      const store = files();
      if (!store.meta) return [err('export: no project is open')];
      const blob = await exportZip(store.meta.name, store.files, store.dirs);
      const filename = `${safeArchiveName(store.meta.name)}.zip`;
      downloadBlob(blob, filename);
      return [info(`exported ${Object.keys(store.files).length} files to ${filename}`)];
    },
  };
}

/** Helper used by the file tree when dropping a node onto a folder. */
export function targetPathFor(sourcePath: string, destinationDir: string): string {
  return joinPath(destinationDir, basename(sourcePath));
}
