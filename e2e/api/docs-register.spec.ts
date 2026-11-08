import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../src/fixtures';
import { PLATFORM_DOCS_DIR } from '../src/env';

/**
 * The feature register (backend/app/platform_docs/register.md) must keep up with main: every frontend
 * route in frontend/src/App.tsx and every e2e spec is named in it, and everything it names exists.
 * Backend endpoints are checked by backend/tests/test_platform_docs_register.py. Pure file reads: needs
 * the monorepo checkout with its submodules, no running service.
 */
const APP_TSX = process.env.FRONTEND_APP_TSX ?? '../frontend/src/App.tsx';
const register = (): string => readFileSync(join(PLATFORM_DOCS_DIR, 'register.md'), 'utf8');

/** Full paths of every <Route path> in App.tsx, nested paths joined onto their parents. */
export function appRoutes(src: string): string[] {
  const routes = new Set<string>();
  const stack: string[] = [];
  const join2 = (parent: string, path: string) =>
    path.startsWith('/') ? path : `${parent.replace(/\/$/, '')}/${path}`.replace(/\/$/, '') || '/';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('</Route>', i)) {
      stack.pop();
      i += 8;
      continue;
    }
    if (src.startsWith('<Route', i) && /[\s>]/.test(src[i + 6])) {
      let depth = 0;
      let j = i + 6;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        else if (src[j] === '>' && depth === 0) break;
      }
      const tag = src.slice(i, j + 1);
      const selfClosing = src[j - 1] === '/';
      let d = 0; // blank out {…} attribute values so only this tag's own path="…" is read
      const attrs = [...tag].map((c) => {
        if (c === '{') d++;
        const out = d > 0 ? ' ' : c;
        if (c === '}') d--;
        return out;
      }).join('');
      const m = attrs.match(/\spath="([^"]*)"/);
      const parent = stack.length ? stack[stack.length - 1] : '';
      const full = m ? join2(parent, m[1].replace(/\/\*$/, '')) : parent;
      if (m && m[1] !== '*' && full) routes.add(full);
      if (!selfClosing) stack.push(full);
      i = j + 1;
      continue;
    }
    i++;
  }
  return [...routes].sort();
}

const specFiles = (): string[] =>
  ['api', 'web'].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.spec.ts')).map((f) => `e2e/${dir}/${f}`)).sort();

test.describe('@docs feature register stays current', () => {
  test('the route parser reads nesting the way App.tsx means it', () => {
    const src = `<Route path="/auth" element={<A />}><Route path="login" element={<B />} /></Route>
      <Route path="/dashboard" element={<P><G roles={['A']}><L /></G></P>}><Route index element={<O />} />
      <Route path="patients/:id" element={<X />} /></Route><Route path="/admin/*" element={<Y />}>
      <Route path="services" element={<S />} /></Route><Route path="*" element={<N />} />`;
    expect(appRoutes(src)).toEqual(['/admin', '/admin/services', '/auth', '/auth/login', '/dashboard', '/dashboard/patients/:id']);
  });

  test('every frontend route is in the register', () => {
    const text = register();
    const missing = appRoutes(readFileSync(APP_TSX, 'utf8')).filter((r) => !text.includes(`\`${r}\``));
    expect(missing).toEqual([]);
  });

  test('every e2e spec is named by a feature, and every named spec exists', () => {
    const text = register();
    const named = [...new Set(text.match(/e2e\/(?:api|web)\/[\w.-]+\.spec\.ts/g) ?? [])].sort();
    const all = specFiles();
    expect(all.filter((s) => !named.includes(s))).toEqual([]);
    expect(named.filter((s) => !all.includes(s))).toEqual([]);
  });
});
