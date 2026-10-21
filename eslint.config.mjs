import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// The left-hand side of an exit-code write, dot or bracket form. Kept as one
// combinator so the guard test can still find a single pattern by its message.
const exitCodeTarget =
  "AssignmentExpression[left.object.name='process']:matches([left.property.name='exitCode'], [left.property.value='exitCode'])";

export default tseslint.config(
  {
    // A second copy of this repo inside the tree — an agent worktree under `.qoder/`, a
    // scratch clone — brings its own `eslint.config.mjs`, which ESLint discovers and
    // merges. Two configs then ask for a TS program from different roots and every file
    // in the run fails to parse (217 main-tree files, measured), not just the copy.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'docs/.vitepress/dist/**', 'docs/.vitepress/cache/**', '.agents/**', '.claude/**', '.qoder/**']
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: {
      // A stale disable comment hides the next real finding, and warnings do not
      // fail `npm run lint`; make the directive itself an error.
      reportUnusedDisableDirectives: 'error'
    },
    languageOptions: {
      globals: {
        require: true,
        process: true,
        __dirname: true,
        exports: true,
        setTimeout: true,
        clearInterval: true
      }
    },
    rules: {
      // Intentional empty blocks are the swallow-and-continue contract in
      // storage (a note vanishing mid-scan is a legal outcome, not a bug); an
      // empty `if`/`try` still has to be written down.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // A callback that returns on one branch and not another silently produces
      // `undefined` entries in map/filter/sort results.
      'array-callback-return': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      // CommonJS output: require() is the real module primitive here.
      '@typescript-eslint/no-require-imports': 'off',
      // `_` marks deliberately unused bindings. Catch bindings are checked too
      // (`caughtErrors: 'all'` is the typescript-eslint default); a rethrow uses
      // its binding, so `none` would only hide genuinely dead catches.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ],
      // `x != null` is the repo's "neither null nor undefined" idiom; every other
      // comparison stays strict.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/no-useless-empty-export': 'error',
      // The globals block above is a partial list; tsc resolves the rest.
      'no-undef': 'off'
    }
  },
  {
    // The documented PR rule is zero `any` casts in `src/` (agent.md, PR
    // checklist). It was asserted but unchecked: the block above turned the
    // rule off repo-wide, so `npm run lint` passed on any input. Re-armed for
    // shipped code only — `test/` keeps it off deliberately, where `any` is
    // the pragmatic way to reach into a parsed-frontmatter fixture. Everything
    // else in this block is shipped-only for the same shape of reason: a fixture
    // may fire-and-forget, its sleep helpers return from the promise executor,
    // and asserting `process.exitCode = 2` in one is testing the contract, not
    // breaking it. The exit-code guard enforces what `src/cli/exit-codes.ts` states
    // in its own header; ADR-0024 owns the matrix those values report.
    files: ['src/**/*.ts', 'bin/**/*.ts'],
    languageOptions: {
      parserOptions: {
        // The type-aware rules below need a program; this block's `files` keeps
        // `test/**` from being checked by them, which is what the exemption is for.
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // Type-aware bug classes tsc cannot see: async callbacks passed to void
      // contexts, unbound methods, non-Error throws/rejections, string/Map/Set
      // spreads, and missing union cases. All measured zero on shipped code.
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-misused-spread': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/unbound-method': 'error',
      // The sleep and prompt helpers mean "wait"; a value returned from the
      // executor cannot be read, so the body must not return one.
      'no-promise-executor-return': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Direct literals, TS wrappers (`as`, `!`, `satisfies`, `<number>`),
          // negative literals, and bracket writes. One comma-separated string
          // keeps the single-pattern contract the guard test asserts.
          selector: [
            `${exitCodeTarget} > Literal`,
            `${exitCodeTarget} > :matches(TSAsExpression, TSNonNullExpression, TSSatisfiesExpression, TSTypeAssertion) > Literal`,
            `${exitCodeTarget} > UnaryExpression[operator='-'] > Literal`
          ].join(', '),
          message: 'Set process.exitCode from ExitCode or exitCodeFor(), never a numeric literal.'
        }
      ]
    }
  },
  {
    // The CLI owns stdout: a log from a library layer corrupts `--json` and
    // duplicates the handler's message. `bin/` and `src/cli/` keep console.
    files: ['src/**/*.ts'],
    ignores: ['src/cli/**'],
    rules: {
      'no-console': 'error'
    }
  }
);
