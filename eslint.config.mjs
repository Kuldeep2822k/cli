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
      'no-empty': 'off',
      'prefer-const': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-undef': 'off'
    }
  }
);
