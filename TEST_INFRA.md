# E2E Test Infra: PALEE Documentation & Contracts (Issue #113)

## Test Philosophy
- Multi-tier verification: Unit & CLI tests (`npm test`), strict TypeScript compilation (`npm run check`), VitePress production documentation compilation (`npm run docs:build`), link integrity, and responsive CSS theme verification.

## Quality Gates & Verification Commands
1. **Unit & Integration Test Suite**:
   - Command: `npm test`
   - Target: All 19 test suites in `test/` (230 tests) pass with 0 failures.
2. **TypeScript & Linter Check**:
   - Command: `npm run check`
   - Target: TypeScript compiler (`tsc --noEmit`) and linter report 0 errors.
3. **VitePress Documentation Build**:
   - Command: `npm run docs:build`
   - Target: Clean build in production mode (`npx vitepress build docs`) with zero broken internal links.
4. **Theme Accessibility & Contrast**:
   - Target: Mermaid diagram card background uses `.dark` scoping and light mode theme variables (`var(--vp-c-bg-soft)`, `var(--vp-c-divider)`).
5. **Git Delivery**:
   - Branch: `docs/issue-113-humanization-and-fixes`
   - Target: PR opened against `main`.
