import { bundle, type BuildDiagnostic } from '@/lib/bundler';
import { dirname, normalizePath } from '@/lib/vfs';
import { escapeHtml } from '@/lib/utils';

/**
 * Builds the document that runs inside the preview iframe.
 *
 * The iframe is sandboxed with `allow-scripts` only — no `allow-same-origin` —
 * so the preview lives in an opaque origin and cannot read the IDE's storage,
 * cookies or DOM. The only channel back is `postMessage`, which the preview
 * panel validates by source before trusting.
 */

import { ESM_CDN_URLS, useSettingsStore } from '@/stores/settingsStore';
import { loadPreviewRuntime, runtimeLoadError } from '@/lib/previewRuntime';

export interface PreviewBuild {
  html: string;
  entry: string;
  errors: BuildDiagnostic[];
  warnings: BuildDiagnostic[];
  /** Bare specifiers the preview must fetch from the package CDN at runtime. */
  externals: string[];
  /** Bare specifiers compiled in from the locally hosted runtime. */
  bundledPackages: string[];
  durationMs: number;
  /**
   * What the bundler actually produced, in bytes.
   *
   * Measured from the output esbuild returned rather than estimated from the
   * sources: the profiler reports these as a fact about this build, and an
   * estimate presented as a measurement is the thing it must never do.
   */
  bytes: { js: number; css: number; html: number };
}

const ENTRY_CANDIDATES = [
  'src/main.tsx',
  'src/main.ts',
  'src/main.jsx',
  'src/main.js',
  'src/index.tsx',
  'src/index.ts',
  'src/index.jsx',
  'src/index.js',
  'main.tsx',
  'main.ts',
  'main.jsx',
  'main.js',
  'index.tsx',
  'index.ts',
  'index.jsx',
  'index.js',
  'app.js',
];

/**
 * Does this document already carry its own program?
 *
 * A `<script>` with a body, rather than a `src`, is code the author put in the
 * page. It is not a reference to something that needs building — it *is* the
 * program, and it runs when the browser parses the document.
 */
function hasInlineScript(html: string): boolean {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    if (match[2].trim()) return true;
  }
  return false;
}

/**
 * Locate the script entry point, preferring what index.html actually loads.
 *
 * The order is the whole of it, and the last step is where this used to go
 * wrong. An ordinary standalone page — a `<style>`, some markup, an inline
 * `<script>`, no build step — fell past the first check, because it names no
 * script to load, and landed on the conventional-entry list. In a project that
 * still had a template's `src/main.tsx` lying around, the preview then bundled
 * *that* and injected it into the author's document, and the first thing the
 * user saw was the React entry's own assertion failing:
 *
 *   Uncaught Error: Root element #root is missing from index.html
 *
 * Which was true, and none of their business. They had not asked for React,
 * and `#root` is one framework's convention, not a requirement a browser IDE
 * gets to impose on every HTML file.
 *
 * So a document that carries its own inline script is taken at its word: it is
 * the program, and nothing is appended to it. The conventional-entry list is
 * for the case it was always for — a project whose page does not say what to
 * run, or which has no page at all.
 */
export function findEntry(files: Record<string, string>): string | null {
  const html = files['index.html'] ?? files['public/index.html'];
  if (html) {
    const scriptMatch = [...html.matchAll(/<script[^>]*src=["']([^"']+)["'][^>]*>/gi)];
    for (const match of scriptMatch) {
      const src = match[1];
      if (/^https?:/.test(src)) continue;
      try {
        const resolved = normalizePath(src);
        if (resolved in files) return resolved;
      } catch {
        // Ignore unresolvable script tags and keep looking.
      }
    }
    // The page brought its own code. Adding a second program to it would run
    // something the author never referenced.
    if (hasInlineScript(html)) return null;
  }
  return ENTRY_CANDIDATES.find((candidate) => candidate in files) ?? null;
}

/**
 * The runtime bridge injected into every preview document.
 *
 * Exported so its gating can be asserted: this script runs inside the sandbox
 * and is the only channel across it in either direction, so which messages it
 * acts on is a security property, not an implementation detail.
 */
export const BRIDGE = `<script>
(function () {
  var overlayShown = false;
  var showOverlay = function (title, detail) {
    if (overlayShown) return;
    overlayShown = true;
    var box = document.createElement('div');
    box.setAttribute('data-forge-overlay', '');
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:24px;' +
      'background:#0b0f17;color:#e6e9f5;font:13px/1.6 ui-monospace,SFMono-Regular,monospace;';
    var h = document.createElement('h1');
    h.textContent = title;
    h.style.cssText = 'font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#ffb4ab;margin:0 0 12px;';
    var p = document.createElement('pre');
    p.textContent = detail;
    p.style.cssText = 'white-space:pre-wrap;margin:0;border-left:2px solid #ffb4ab;padding-left:12px;';
    box.appendChild(h);
    box.appendChild(p);
    (document.body || document.documentElement).appendChild(box);
  };

  var send = function (level, args) {
    try {
      parent.postMessage({
        source: 'forge-preview',
        level: level,
        message: Array.prototype.map.call(args, function (a) {
          if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a, null, 2); } catch (e) { return String(a); }
        }).join(' ')
      }, '*');
    } catch (e) { /* the parent may be gone during teardown */ }
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level].bind(console);
    console[level] = function () { send(level, arguments); original.apply(console, arguments); };
  });
  window.addEventListener('error', function (event) {
    // A failed <script>/<link> load reports a target instead of a message.
    var target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      var url = target.src || target.href;
      send('error', ['Failed to load ' + url]);
      showOverlay('Resource failed to load', url + '\\n\\nIf this is a package URL, the CDN could not be reached from this network.');
      return;
    }
    var where = (event.filename || 'preview') + ':' + event.lineno + ':' + event.colno;
    send('error', [event.message + ' (' + where + ')']);
    showOverlay('Runtime error', event.message + '\\n\\nat ' + where);
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var detail = event.reason && event.reason.stack ? event.reason.stack : String(event.reason);
    send('error', ['Unhandled promise rejection: ' + detail]);
    showOverlay('Unhandled promise rejection', detail);
  });
  // A bare import that never resolves leaves the page silently blank; say so.
  window.addEventListener('load', function () {
    setTimeout(function () {
      var body = document.body;
      if (!body || overlayShown) return;
      var hasContent = body.innerText.trim().length > 0 ||
        body.querySelector('canvas, svg, img, input, button');
      if (!hasContent) {
        showOverlay(
          'Nothing rendered',
          'The bundle ran but produced no output.\\n\\n' +
          'Common causes: the entry point does not mount anything, the root element in ' +
          'index.html does not match, or a package could not be fetched from the CDN.'
        );
      }
    }, 2500);
  });
  /*
   * Inspect mode: picking an element in the preview, from the outside.
   *
   * The parent cannot reach into this document — the frame is sandboxed
   * without allow-same-origin, deliberately — so element picking has to run
   * in here and report back over the same channel. It is off until the host
   * asks for it, and only the host may ask: the message must come from our
   * own parent window.
   *
   * What goes back is a description, never a node: tag, id, classes, own
   * text, and a readable path. Matching that back to a line of source is the
   * host's problem, and an inexact one, which is said there rather than
   * papered over here.
   */
  var inspecting = false;
  var marker = null;
  var hovered = null;

  var markerFor = function () {
    if (marker) return marker;
    marker = document.createElement('div');
    marker.setAttribute('data-forge-inspect', '');
    marker.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;' +
      'border:1px solid #2bb3d6;background:rgba(43,179,214,0.16);border-radius:2px;' +
      'transition:all 60ms ease-out;';
    (document.body || document.documentElement).appendChild(marker);
    return marker;
  };

  var describe = function (el) {
    var own = '';
    for (var i = 0; i < el.childNodes.length; i += 1) {
      if (el.childNodes[i].nodeType === 3) own += el.childNodes[i].nodeValue;
    }
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && path.length < 8) {
      var step = node.tagName.toLowerCase();
      if (node.id) step += '#' + node.id;
      else if (node.classList && node.classList.length) step += '.' + node.classList[0];
      path.unshift(step);
      node = node.parentElement;
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: el.classList ? Array.prototype.slice.call(el.classList) : [],
      text: own.trim().slice(0, 200),
      path: path.join(' > ')
    };
  };

  var onOver = function (event) {
    if (!inspecting) return;
    var el = event.target;
    if (!el || el.nodeType !== 1 || el.hasAttribute('data-forge-inspect')) return;
    hovered = el;
    var box = el.getBoundingClientRect();
    var m = markerFor();
    m.style.top = box.top + 'px';
    m.style.left = box.left + 'px';
    m.style.width = box.width + 'px';
    m.style.height = box.height + 'px';
  };

  var onPick = function (event) {
    if (!inspecting) return;
    // The page's own handlers must not fire: a click meant to select a
    // button should not also submit the form it sits in.
    event.preventDefault();
    event.stopPropagation();
    var el = event.target && event.target.nodeType === 1 ? event.target : hovered;
    if (!el) return;
    try {
      parent.postMessage({ source: 'forge-preview', level: 'inspect', selection: describe(el) }, '*');
    } catch (e) { /* the parent may be gone during teardown */ }
  };

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('click', onPick, true);
  document.addEventListener('mousedown', function (event) {
    if (inspecting) { event.preventDefault(); event.stopPropagation(); }
  }, true);

  window.addEventListener('message', function (event) {
    // Only our own host may turn this on.
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.source !== 'forge-host' || data.type !== 'inspect') return;
    inspecting = !!data.enabled;
    document.documentElement.style.cursor = inspecting ? 'crosshair' : '';
    if (!inspecting && marker) {
      marker.parentNode.removeChild(marker);
      marker = null;
      hovered = null;
    }
  });

  parent.postMessage({ source: 'forge-preview', level: 'ready', message: 'preview-ready' }, '*');
})();
</script>`;

function importMap(externals: string[], pins: Record<string, string>): string {
  if (!externals.length) return '';
  const cdn = ESM_CDN_URLS[useSettingsStore.getState().runtime.esmCdn] ?? ESM_CDN_URLS['esm.sh'];
  const imports: Record<string, string> = {};
  for (const name of externals) {
    const version = pins[name];
    // The CDN serves an ES module build for any npm package, pinned to whatever
    // package.json declares so the preview matches the manifest.
    const spec = `${name}${version ? `@${version}` : ''}`;
    imports[name] = cdn(spec);
    imports[`${name}/`] = `${cdn(spec).replace(/\/\+esm$/, '')}/`;
  }
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}

type Reachability = 'unknown' | 'reachable' | 'unreachable';

let cdnState: Reachability = 'unknown';
let cdnProbe: Promise<Reachability> | null = null;

/** Test seam: forget what we learned about the CDN. */
export function resetCdnReachability(): void {
  cdnState = 'unknown';
  cdnProbe = null;
}

export function cdnReachability(): Reachability {
  return cdnState;
}

/**
 * Check whether the configured package CDN can be reached, once per session.
 *
 * Without this, a blocked CDN produces a preview that builds cleanly and then
 * renders nothing, because the import map's URLs fail inside the sandbox where
 * we cannot see the failure until the runtime bridge reports it. Probing lets
 * the build itself explain what is wrong.
 */
async function probeCdn(spec: string): Promise<Reachability> {
  if (cdnState !== 'unknown') return cdnState;
  if (cdnProbe) return cdnProbe;
  cdnProbe = (async () => {
    const cdn = ESM_CDN_URLS[useSettingsStore.getState().runtime.esmCdn] ?? ESM_CDN_URLS['esm.sh'];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      // Any HTTP answer means the host is reachable; only a network-level
      // failure (blocked, offline, DNS) counts as unreachable.
      await fetch(cdn(spec), { signal: controller.signal, cache: 'force-cache' });
      cdnState = 'reachable';
    } catch {
      cdnState = 'unreachable';
    } finally {
      clearTimeout(timer);
    }
    return cdnState;
  })();
  return cdnProbe;
}

/** Read dependency pins out of package.json, ignoring range prefixes. */
export function readDependencyPins(files: Record<string, string>): Record<string, string> {
  const raw = files['package.json'];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pins: Record<string, string> = {};
    for (const [name, range] of Object.entries({
      ...(parsed.devDependencies ?? {}),
      ...(parsed.dependencies ?? {}),
    })) {
      const cleaned = String(range).replace(/^[\^~>=<\s]*/, '').trim();
      if (/^\d/.test(cleaned)) pins[name] = cleaned;
    }
    return pins;
  } catch {
    return {};
  }
}

function inlineStylesheets(html: string, files: Record<string, string>, htmlPath: string): string {
  return html.replace(
    /<link[^>]*rel=["']stylesheet["'][^>]*>/gi,
    (tag) => {
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!href || /^https?:/.test(href)) return tag;
      let resolved: string | null = null;
      try {
        resolved = normalizePath(href.startsWith('/') ? href : `${dirname(htmlPath)}/${href}`);
      } catch {
        resolved = null;
      }
      if (!resolved || !(resolved in files)) return tag;
      return `<style data-forge-src="${escapeHtml(resolved)}">\n${files[resolved]}\n</style>`;
    },
  );
}

function stripLocalScripts(html: string): string {
  return html.replace(/<script[^>]*src=["'](?!https?:)[^"']+["'][^>]*>\s*<\/script>/gi, '');
}

function errorDocument(errors: BuildDiagnostic[]): string {
  const rows = errors
    .map(
      (error) => `<li><span class="loc">${escapeHtml(error.path)}:${error.line}:${error.column}</span>
        <span class="msg">${escapeHtml(error.message)}</span></li>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; font: 13px/1.6 ui-monospace, SFMono-Regular, monospace; background:#0b0f17; color:#e6e9f5; padding:24px; }
    h1 { font-size: 13px; letter-spacing:.08em; text-transform:uppercase; color:#ffb4ab; margin:0 0 16px; }
    ul { list-style:none; margin:0; padding:0; display:grid; gap:12px; }
    li { border-left:2px solid #ffb4ab; padding-left:12px; }
    .loc { display:block; color:#8c909f; font-size:11px; margin-bottom:2px; }
    .msg { white-space:pre-wrap; }
  </style></head><body><h1>Build failed — ${errors.length} error${errors.length === 1 ? '' : 's'}</h1><ul>${rows}</ul>${BRIDGE}</body></html>`;
}

export function emptyDocument(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; height:100vh; display:grid; place-items:center; background:#0b0f17;
      color:#8c909f; font: 13px ui-sans-serif, system-ui, sans-serif; text-align:center; padding:24px; }
  </style></head><body><p>${escapeHtml(message)}</p></body></html>`;
}

/**
 * Compile the project and produce a complete HTML document.
 * Build errors become a readable error page rather than a blank frame.
 */
export async function buildPreview(files: Record<string, string>): Promise<PreviewBuild> {
  const entry = findEntry(files);
  const htmlPath = 'index.html' in files ? 'index.html' : 'public/index.html';
  const rawHtml = files[htmlPath];

  if (!entry) {
    if (rawHtml) {
      const doc = inlineStylesheets(rawHtml, files, htmlPath);
      const doubled = injectBridge(doc);
      return {
        html: doubled,
        entry: htmlPath,
        errors: [],
        warnings: [],
        externals: [],
        bundledPackages: [],
        durationMs: 0,
        // Nothing was bundled: this document is the whole output.
        bytes: { js: 0, css: 0, html: doubled.length },
      };
    }
    return {
      html: emptyDocument(
        'No entry point found. Add an index.html or a src/main.{ts,tsx,js,jsx} file, then press Run.',
      ),
      entry: '',
      errors: [],
      warnings: [],
      externals: [],
      bundledPackages: [],
      durationMs: 0,
      bytes: { js: 0, css: 0, html: 0 },
    };
  }

  const runtime = await loadPreviewRuntime();
  const result = await bundle(files, entry, runtime);
  if (result.errors.length) {
    return {
      bytes: { js: 0, css: 0, html: 0 },
      html: errorDocument(result.errors),
      entry,
      errors: result.errors,
      warnings: result.warnings,
      externals: result.externals,
      bundledPackages: result.bundledPackages,
      durationMs: result.durationMs,
    };
  }

  // Anything still external has to come over the network. Find out now, so a
  // blocked CDN produces a readable error page instead of a blank frame.
  if (result.externals.length) {
    const reach = await probeCdn(result.externals[0]);
    if (reach === 'unreachable') {
      const cdnName = useSettingsStore.getState().runtime.esmCdn;
      const missing = result.externals.join(', ');
      const errors: BuildDiagnostic[] = [
        {
          path: entry,
          line: 1,
          column: 1,
          severity: 'error',
          message:
            `Cannot reach ${cdnName} to load ${result.externals.length} package(s): ${missing}.\n\n` +
            'The build succeeded — only the runtime dependencies are missing. Options:\n' +
            '  • Settings → Runtime → switch the package CDN (esm.sh ↔ jsDelivr).\n' +
            '  • Remove the import, or replace it with code in this project.\n' +
            (runtime.react
              ? `  • React ${runtime.react} and its JSX runtimes are served locally and need no CDN.`
              : '  • The local preview runtime did not load, so even React needs the CDN: ' +
                `${runtimeLoadError() ?? 'reason unknown'}. Run "npm run build:preview-runtime".`),
        },
      ];
      return {
        bytes: { js: 0, css: 0, html: 0 },
        html: errorDocument(errors),
        entry,
        errors,
        warnings: result.warnings,
        externals: result.externals,
        bundledPackages: result.bundledPackages,
        durationMs: result.durationMs,
      };
    }
  }

  const pins = readDependencyPins(files);
  const head = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    importMap(result.externals, pins),
    result.css ? `<style>${result.css}</style>` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const script = `<script type="module">\n${result.js}\n</script>`;

  let html: string;
  if (rawHtml) {
    const withStyles = stripLocalScripts(inlineStylesheets(rawHtml, files, htmlPath));
    html = withStyles.includes('</head>')
      ? withStyles.replace('</head>', `${head}\n</head>`)
      : `${head}\n${withStyles}`;
    html = html.includes('</body>')
      ? html.replace('</body>', `${BRIDGE}\n${script}\n</body>`)
      : `${html}\n${BRIDGE}\n${script}`;
  } else {
    html = `<!doctype html><html lang="en"><head>${head}</head><body><div id="root"></div><div id="app"></div>${BRIDGE}${script}</body></html>`;
  }

  return {
    html,
    entry,
    errors: [],
    warnings: result.warnings,
    externals: result.externals,
    bundledPackages: result.bundledPackages,
    durationMs: result.durationMs,
    bytes: { js: result.js.length, css: result.css.length, html: html.length },
  };
}

function injectBridge(html: string): string {
  return html.includes('</body>') ? html.replace('</body>', `${BRIDGE}</body>`) : html + BRIDGE;
}
