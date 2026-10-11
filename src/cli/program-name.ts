/**
 * Program Name Resolution
 *
 * @remarks
 * Single source of truth for the bin name every user-facing string prints.
 * `package.json` ships one bin, but a user can install or invoke the CLI under
 * another name (`palee-test` for a parallel install that must not clobber the
 * published command), and then every suggested invocation has to name the
 * binary they actually have — a copy-pasted `palee …` from a `palee-test`
 * install fails (#314).
 *
 * Commander does derive a name from the invoked script, but only inside
 * `parse()`: `node_modules/commander/lib/command.js:1051-1053` runs
 * `if (!this._name && this._scriptPath) this.nameFromFilename(this._scriptPath)`
 * and then `this._name = this._name || 'program'`. Two properties make that
 * unusable as the shared source: it never runs before `parse()`, so a handler
 * cannot rely on it, and when `argv[1]` is absent (`from: 'user'`, `--eval`) it
 * falls back to the literal `'program'`, which no shipped binary should print.
 * So `bin/palee.ts` pins the derived name through `.name()` and the handlers
 * read that same pinned value back — one value, so help text and hints cannot
 * drift apart.
 */

import path from 'path';
import { program } from 'commander';

/**
 * The bin key shipped in `package.json`. Used when the invocation gives no
 * usable name (a bare `node -e` require, an `argv[1]` that is only an
 * extension) and as the answer for a process that never ran `bin/palee.ts`.
 */
const DEFAULT_PROGRAM_NAME = 'palee';

/**
 * Extensions that identify `argv[1]` as a script file rather than as a bin
 * shim, so they are stripped the way `nameFromFilename` strips them. Any other
 * extension (`palee.v2`) is part of the invoked name and is kept whole; a
 * dot-file's `path.extname` is empty, so it needs no extra guard.
 */
const SCRIPT_EXTENSIONS: readonly string[] = ['.js', '.cjs', '.mjs', '.ts', '.tsx'];

/**
 * Derives the invoked bin name from an entry path.
 *
 * @param invokedPath - Path to derive from; defaults to `process.argv[1]`
 * @returns The invoked name, or `palee` when the path gives no usable name
 *
 * @remarks
 * `path.extname` behaviour matters here and is what this function is pinned
 * against: `extname('palee.v2')` is `.v2` while `extname('.js')` is empty, so
 * only a real script extension is stripped.
 *
 * @example
 * ```typescript
 * deriveProgramName('/usr/local/bin/palee-test');     // 'palee-test'
 * deriveProgramName('D:\\pkg\\dist\\bin\\palee.js');  // 'palee'
 * deriveProgramName('');                              // 'palee'
 * ```
 */
export function deriveProgramName(invokedPath: string | undefined = process.argv[1]): string {
  if (!invokedPath) return DEFAULT_PROGRAM_NAME;

  const base = path.basename(invokedPath);
  const ext = path.extname(base);
  return ext && SCRIPT_EXTENSIONS.includes(ext.toLowerCase())
    ? base.slice(0, base.length - ext.length)
    : base;
}

/**
 * The program name a handler must print.
 *
 * @returns The name `bin/palee.ts` pinned on Commander, or the published `palee`
 * bin for a process that never ran the CLI entry point
 *
 * @remarks
 * Reads the name back off the same Commander instance that renders the help
 * (`name()` with no argument is a getter over the field `.name()` writes, so it
 * is exactly the string in the `Usage:` line) instead of re-deriving it. An
 * import of a handler without the entry point — a unit test, or a library
 * consumer — has pinned nothing, and gets the published name rather than the
 * host process's own script name.
 *
 * @example
 * ```typescript
 * reportError(`Vault path not configured. Run: ${programName()} config set-vault <path>`);
 * ```
 */
export function programName(): string {
  return program.name() || DEFAULT_PROGRAM_NAME;
}
