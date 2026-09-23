# PALEE src/ static import graph (generated)

Modules: 60 · internal edges: 216 (33 type-only) · produced by `node scripts/arch-import-graph.cjs`.


## Layer edge matrix

| from => to | edges |
| --- | --- |
| src/validation => src/validation | 54 |
| src/cli => src/cli | 31 |
| src/storage => src/storage | 27 |
| src/cli => src/validation | 22 |
| bin => src/cli | 12 |
| src/validation => src/storage | 12 |
| src/cli => src(root) | 11 |
| src/cli => src/storage | 10 |
| src/storage => src(root) | 9 |
| src/cli => src/engine | 8 |
| src/validation => src/engine | 7 |
| src/engine => src/engine | 4 |
| src/validation => src(root) | 3 |
| src/engine => src(root) | 2 |
| src(root) => src(root) | 1 |
| src(root) => src/engine | 1 |
| src(root) => src/storage | 1 |
| src(root) => src/validation | 1 |

## Fan-out (impact radius) top 20

| module | out-edges |
| --- | --- |
| `src/cli/validate` | 26 |
| `src/validation/index` | 22 |
| `bin/palee` | 12 |
| `src/storage/index` | 11 |
| `src/cli/plan` | 7 |
| `src/cli/review` | 7 |
| `src/cli/adopt` | 6 |
| `src/cli/dashboard` | 6 |
| `src/cli/progress` | 6 |
| `src/cli/roadmap` | 6 |
| `src/validation/collect-vault` | 6 |
| `src/cli/migrate` | 5 |
| `src/cli/next` | 5 |
| `src/cli/session` | 5 |
| `src/storage/loader` | 5 |
| `src/index` | 4 |
| `src/validation/rules/valid-session-schema` | 4 |
| `src/validation/rules/valid-topic-mastery` | 4 |
| `src/validation/types` | 4 |
| `src/engine/index` | 3 |

## Fan-in (change susceptibility) top 20

| module | in-edges |
| --- | --- |
| `src/types` | 26 |
| `src/validation/types` | 23 |
| `src/cli/exit-codes` | 12 |
| `src/cli/config` | 11 |
| `src/storage/index` | 11 |
| `src/cli/onboarding` | 10 |
| `src/engine/mastery` | 8 |
| `src/storage/frontmatter` | 8 |
| `src/engine/dependency` | 5 |
| `src/storage/memory` | 5 |
| `src/storage/sessions` | 5 |
| `src/validation/rules/diagnostic-value` | 5 |
| `src/storage/vault-walker` | 4 |
| `src/storage/loader` | 4 |
| `src/validation/rules/assessed-at` | 4 |
| `src/engine/topic-id` | 4 |
| `src/validation/rules/valid-session-schema` | 3 |
| `src/storage/cache` | 3 |
| `src/engine/sm2` | 2 |
| `src/validation/collect-vault` | 2 |

## Cycles (file-granularity SCCs > 1)

- none

## Barrel imports (layer index files)

- src/cli/adopt -> src/storage/index
- src/cli/dashboard -> src/storage/index
- src/cli/exit-codes -> src/storage/index
- src/cli/migrate -> src/storage/index
- src/cli/next -> src/storage/index
- src/cli/plan -> src/storage/index
- src/cli/progress -> src/storage/index
- src/cli/review -> src/storage/index
- src/cli/roadmap -> src/storage/index
- src/cli/session -> src/storage/index
- src/index -> src/engine/index
- src/index -> src/storage/index
- src/index -> src/validation/index

## Layer order permitted by agent.md:9-16

Each row lists the layers the source layer may import.

- `bin` → `src/cli`, `src(root)`, `src/engine`, `src/storage`, `src/validation`
- `src/cli` → `src/cli`, `src/engine`, `src/storage`, `src/validation`, `src(root)`
- `src/engine` → `src/engine`, `src(root)`
- `src/storage` → `src/storage`, `src(root)`
- `src/validation` → `src/validation`, `src/engine`, `src/storage`, `src(root)`
- `src(root)` → `src(root)`, `src/cli`, `src/engine`, `src/storage`, `src/validation`

## Edges against that documented rule (0)

- none

## External packages imported

- `fs` (15 import sites)
- `path` (11 import sites)
- `crypto` (5 import sites)
- `readline` (3 import sites)
- `os` (2 import sites)
- `yaml` (2 import sites)
- `commander` (1 import sites)

## Unresolved relative specifiers

- `bin/palee` -> ../package.json (line 8)
- `src/index` -> ../package.json (line 9)
