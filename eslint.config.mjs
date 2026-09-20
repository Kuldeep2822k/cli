import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'docs/.vitepress/dist/**', 'docs/.vitepress/cache/**', '.agents/**']
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
      // storage (a note vanishing mid-scan is a legal outcome, not a bug).
      'no-empty': 'off',
      // Reassignment during iterative graph walks is deliberate; tsc's
      // noUnusedLocals catches the case that actually matters.
      'prefer-const': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // CommonJS output: require() is the real module primitive here.
      '@typescript-eslint/no-require-imports': 'off',
      // Test doubles and catch bindings are routinely named but unread.
      '@typescript-eslint/no-unused-vars': 'off',
      // The globals block above is a partial list; tsc resolves the rest.
      'no-undef': 'off'
    }
  },
  {
    // The documented PR rule is zero `any` casts in `src/` (agent.md, PR
    // checklist). It was asserted but unchecked: the block above turned the
    // rule off repo-wide, so `npm run lint` passed on any input. Re-armed for
    // shipped code only — `test/` keeps it off deliberately, where `any` is
    // the pragmatic way to reach into a parsed-frontmatter fixture.
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
);
