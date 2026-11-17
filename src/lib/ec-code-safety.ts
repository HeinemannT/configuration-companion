/**
 * The rule for every Extended Code script the extension builds:
 *
 *   A property that can hold code is read ONLY inside the argument of
 *   `output(…)` (`output(_o.expression.whenMissing(""))`), or written as a
 *   named argument (`change(prop := …)`). Nothing else touches it: no bare
 *   `_o.expression`, no `str(…)`, `.whenMissing(…)`, `.size()`, `.indexOf(…)`,
 *   comparison or variable assignment on the bare property, and no bare
 *   property name in a `WHERE`, `filter(…)`, `table(…)` or `map(…)`.
 *
 * Why: BMP evaluates a code property whenever it is read as a value. On BMP
 * 5.6.17 the sandbox button `crev_qa_btn_show` (expression `_product := 7 * 6`)
 * answered
 *   `_o.expression`, `str(_o.expression)`, `_o.expression.whenMissing("")` → 42
 *   `_v := _o.expression` then `output(_v)`                               → 42
 *   `SELECT ButtonInput … WHERE expression = 42`                            → 1 match
 *   `_l.filter(expression = 42)`, `_l.table(id, expression)`                → 42
 * and only the `output(…)` forms returned the stored text:
 *   `output(_o.expression)`, `output(_o.expression.whenMissing(""))`,
 *   `output(_o.expression).size()` and `output(_o.expression.size())` (17),
 *   `WHERE output(expression) = "…"`, `_l.filter(output(expression) = "…")`.
 * The same held for ExtendedExpression, ExtendedTable, ActionButton and
 * ReferenceMethodConfig. Running a button's code can change data or send
 * mail even in a read-only preview, and users run these scripts on
 * production servers.
 *
 * One named exception (`ALLOWED_EVALUATIONS`): the template selector of an
 * enterprise object in advanced mode, which BMP itself evaluates on every
 * render. No other.
 *
 * `findEvaluatingCodeReads` checks a script against the rule; the unit test
 * `ec-code-safety.test.ts` runs it over the output of every script builder.
 */

/** Plain-string bodies that hold code (HTML, scripts, rich text). */
const CODE_STRING_PROPS = new Set(['html', 'javascript', 'text', 'longText']);

/** A property name that can hold code: `expression`, any camelCase name
 *  containing `Expression` (`showExpression`, `customNavigationTargetExpressionOnComplete`),
 *  and the plain-string code bodies. Class names (upper case first) are not
 *  properties. `extra` adds discovered custom code properties. */
export function isCodeProperty(name: string, extra?: ReadonlySet<string>): boolean {
  if (!/^[a-z][A-Za-z0-9_]*$/.test(name)) return false;
  return name === 'expression' || name.includes('Expression') || CODE_STRING_PROPS.has(name) || !!extra?.has(name);
}

/** True when any hop of a dotted path (`t.x.expression`) is a code property:
 *  resolving such a path evaluates that code. */
export function pathTouchesCode(path: string, extra?: ReadonlySet<string>): boolean {
  return path.split('.').some(seg => isCodeProperty(seg.replace(/\(.*$/, ''), extra));
}

/**
 * The named exceptions to the rule, each allowed only in this exact form.
 *
 * `enterprise-template-selector`: an enterprise object in advanced mode
 * names its template through an ExtendedExpression (`templateExpression`)
 * that BMP evaluates on every render of that object; no property or command
 * reports the template it chose (the full object read's `template`
 * reference is the simple-mode one, checked on BMP 5.6.17). Evaluating the
 * selector in a non-transactional read is the product's own semantics, far
 * from running a button's action. Written only by template-link
 * `ecResolveEnterpriseTemplate`.
 */
export const ALLOWED_EVALUATIONS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: 'enterprise-template-selector',
    pattern: /(_[A-Za-z0-9]+)Expression := _[A-Za-z0-9]+\.templateExpression\n[ \t]*IF \1Expression = MISSING THEN \1 := MISSING ELSE \1 := \1Expression\.expression ENDIF/g,
  },
];

export interface EvaluatingRead {
  prop: string;
  /** Offset in the script. */
  at: number;
  /** The script around it. */
  context: string;
}

/** Blank out string literals (keeping offsets) so labels and values that
 *  contain a property name are not read as accesses. */
function blankStrings(ec: string): string {
  let out = '';
  let i = 0;
  while (i < ec.length) {
    const c = ec[i];
    if (c !== '"') { out += c; i++; continue; }
    out += '"';
    i++;
    while (i < ec.length && ec[i] !== '"') {
      if (ec[i] === '\\' && i + 1 < ec.length) { out += '  '; i += 2; continue; }
      out += ec[i] === '\n' ? '\n' : ' ';
      i++;
    }
    if (i < ec.length) { out += '"'; i++; }
  }
  return out;
}

/** For every offset, whether it lies inside the argument of an `output(…)`
 *  call. BMP reads code properties there as stored text, whatever follows
 *  them: `output(_o.expression.size())` was 17 (the text's length) and
 *  `output(_o.showExpression.expression)` failed with a missing value on the
 *  text instead of evaluating `showExpression`. */
function insideOutput(text: string): Uint8Array {
  const inside = new Uint8Array(text.length);
  const stack: boolean[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') {
      const isOutput = /(?:^|[^A-Za-z0-9_])output\s*$/.test(text.slice(Math.max(0, i - 12), i));
      stack.push(isOutput);
      if (isOutput) depth++;
    } else if (c === ')') {
      if (stack.pop()) depth--;
    }
    if (depth > 0) inside[i] = 1;
  }
  return inside;
}

/** A named argument of a write (`change(expression := …)`). */
const NAMED_ARG_BEFORE = /[(,]\s*$/;
const NAMED_ARG_AFTER = /^\s*:=/;

/** Every place in `ec` where a code property is read in a form that
 *  evaluates it (see the rule above). Empty for a safe script. */
export function findEvaluatingCodeReads(ec: string, extra?: ReadonlySet<string>): EvaluatingRead[] {
  const text = blankStrings(ec);
  const safe = insideOutput(text);
  for (const ex of ALLOWED_EVALUATIONS) {
    for (const m of text.matchAll(ex.pattern)) safe.fill(1, m.index, m.index + m[0].length);
  }
  const out: EvaluatingRead[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const prop = m[0];
    if (!isCodeProperty(prop, extra)) continue;
    const before = text.slice(Math.max(0, m.index - 200), m.index);
    const after = text.slice(m.index + prop.length, m.index + prop.length + 200);
    if (safe[m.index]) continue;
    if (NAMED_ARG_BEFORE.test(before) && NAMED_ARG_AFTER.test(after)) continue;
    out.push({ prop, at: m.index, context: ec.slice(Math.max(0, m.index - 60), m.index + prop.length + 40) });
  }
  return out;
}
