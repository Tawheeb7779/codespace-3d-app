/**
 * Find the JSX shapes that an external DOM rewriter can turn into a crash.
 *
 * Chrome's translate, Grammarly, password managers and accessibility overlays
 * all replace text nodes with elements carrying replacement text. React keeps a
 * reference to the node it created, so a later commit that has to remove or
 * insert around that node calls `removeChild` with a node that is no longer a
 * child, and the whole tree unmounts:
 *
 *   Failed to execute 'removeChild' on 'Node': The node to be removed is not a
 *   child of this node
 *
 * Only one shape is exposed. A bare text node whose *slot* never changes is
 * only ever updated through `nodeValue`, which silently does nothing on a
 * detached node and cannot throw — problem counts, cursor positions and label
 * interpolations are all that shape and need nothing. The dangerous shape is a
 * bare text node that React may have to remove or insert *around*:
 *
 *   A. a bare text child sitting beside a conditionally mounted element, inside
 *      a parent that survives the change; and
 *   B. a conditional whose branches have different shapes, where at least one
 *      branch pairs an element with bare text — `{busy ? <><Spinner/> saving</>
 *      : 'saved'}` — because the surviving parent must then reconcile a text
 *      node against an element.
 *
 * This walks the real TypeScript AST rather than matching source text, and it
 * is calibrated: `--calibrate <file>` asserts that a known-bad file is still
 * detected, so a scanner that has quietly stopped working cannot report clean.
 *
 *   node scripts/audit-reconciliation.mjs [--calibrate <file>]
 *
 * Exit code is 1 when a finding is reported, so CI can gate on it.
 */
import { readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { globSync } from 'node:fs';
import ts from 'typescript';

/** Whether a JSX text node is real content rather than layout whitespace. */
const isRealText = (node) =>
  ts.isJsxText(node) && node.text.trim().length > 0;

/** The JSX children of an element or fragment, ignoring pure whitespace. */
const childrenOf = (node) =>
  (node.children ?? []).filter((child) => !ts.isJsxText(child) || isRealText(child));

/**
 * What one branch of a conditional puts into its slot.
 *
 * `text` and `element` are the two that matter: a branch that contributes both
 * is the shape in (B), and a slot that is `text` in one branch and `element` in
 * another is the same problem seen from the other side.
 */
function shapeOf(node) {
  if (!node) return new Set(['none']);
  if (ts.isParenthesizedExpression(node)) return shapeOf(node.expression);
  if (ts.isJsxFragment(node) || ts.isJsxElement(node)) {
    // A fragment has no host node of its own, so its children land directly in
    // the parent — that is what makes `<><Spinner/> text</>` dangerous while
    // `<span><Spinner/> text</span>` is not.
    if (ts.isJsxElement(node)) return new Set(['element']);
    const kinds = new Set();
    for (const child of childrenOf(node)) {
      if (isRealText(child)) kinds.add('text');
      else if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) kinds.add('element');
      else if (ts.isJsxExpression(child)) kinds.add('expression');
    }
    return kinds.size ? kinds : new Set(['none']);
  }
  if (ts.isJsxSelfClosingElement(node)) return new Set(['element']);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return new Set(['text']);
  if (ts.isTemplateExpression(node)) return new Set(['text']);
  if (node.kind === ts.SyntaxKind.NullKeyword) return new Set(['none']);
  if (node.kind === ts.SyntaxKind.FalseKeyword) return new Set(['none']);
  if (ts.isConditionalExpression(node)) {
    const set = new Set([...shapeOf(node.whenTrue), ...shapeOf(node.whenFalse)]);
    return set;
  }
  return new Set(['unknown']);
}

/** Every branch of a conditional or `&&` chain, flattened. */
function branchesOf(node) {
  if (ts.isParenthesizedExpression(node)) return branchesOf(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...branchesOf(node.whenTrue), ...branchesOf(node.whenFalse)];
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    // `{cond && <X/>}` is a two-branch conditional: the element, or nothing.
    return [...branchesOf(node.right), { none: true }];
  }
  return [node];
}

/** Does this expression container render JSX conditionally? */
function isConditionalJsx(container) {
  const expression = container.expression;
  if (!expression) return false;
  const branches = branchesOf(expression);
  if (branches.length < 2) return false;
  return branches.some(
    (branch) =>
      branch &&
      !branch.none &&
      (ts.isJsxElement(branch) || ts.isJsxSelfClosingElement(branch) || ts.isJsxFragment(branch)),
  );
}

const findings = [];

function scanFile(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const children = childrenOf(node);
      const bareText = children.filter(isRealText);
      const conditionals = children.filter(
        (child) => ts.isJsxExpression(child) && isConditionalJsx(child),
      );

      // (A) bare text beside something that comes and goes, in a parent that stays.
      if (bareText.length && conditionals.length) {
        findings.push({
          file,
          line: at(bareText[0]),
          shape: 'A',
          detail: `bare text ${JSON.stringify(bareText[0].text.trim().slice(0, 40))} sits beside a conditional element in a parent that survives`,
        });
      }

      // (B) a conditional slot whose branches disagree about text versus element.
      for (const child of children) {
        if (!ts.isJsxExpression(child) || !child.expression) continue;
        const branches = branchesOf(child.expression).filter((b) => b && !b.none);
        if (branches.length < 2) continue;
        const shapes = branches.map(shapeOf);
        const mixesInOneBranch = shapes.some((s) => s.has('text') && s.has('element'));
        const disagrees =
          shapes.some((s) => s.has('text') && !s.has('element')) &&
          shapes.some((s) => s.has('element') && !s.has('text'));
        if (mixesInOneBranch || disagrees) {
          findings.push({
            file,
            line: at(child),
            shape: 'B',
            detail: mixesInOneBranch
              ? 'a branch puts a bare text node next to an element in the parent'
              : 'the branches disagree: one renders text, another an element',
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const calibrateIndex = argv.indexOf('--calibrate');
const calibrateFile = calibrateIndex === -1 ? null : argv[calibrateIndex + 1];

if (calibrateFile) {
  scanFile(calibrateFile);
  const hit = findings.length > 0;
  console.log(
    hit
      ? `calibration PASS: ${findings.length} finding(s) in the known-bad file`
      : 'calibration FAIL: the scanner no longer detects the known-bad shape',
  );
  for (const f of findings) console.log(`  ${f.file}:${f.line}  [${f.shape}] ${f.detail}`);
  exit(hit ? 0 : 1);
}

const files = globSync('src/**/*.tsx').filter((f) => !f.includes('.test.'));
for (const file of files) scanFile(file);

if (!findings.length) {
  console.log(`no exposed reconciliation shapes in ${files.length} files`);
  exit(0);
}
for (const f of findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
  console.log(`${f.file}:${f.line}  [shape ${f.shape}] ${f.detail}`);
}
console.log(`\n${findings.length} finding(s) across ${files.length} files`);
exit(1);
