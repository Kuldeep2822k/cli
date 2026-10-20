import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

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
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      // CommonJS output: require() is the real module primitive here.
      '@typescript-eslint/no-require-imports': 'off',
      // Test doubles and catch bindings are routinely named but unread: `_` marks
      // the deliberate ones, and a rethrow-only `catch (e)` still needs its binding.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }
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
        // Only `no-floating-promises` needs type information. This block's `files` keeps
        // `test/**` from being checked by it, which is what the exemption is for.
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // The sleep and prompt helpers mean "wait"; a value returned from the
      // executor cannot be read, so the body must not return one.
      'no-promise-executor-return': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression[left.object.name='process'][left.property.name='exitCode'] > Literal",
          message: 'Set process.exitCode from ExitCode or exitCodeFor(), never a numeric literal.'
        }
      ]
    }
  }
);
