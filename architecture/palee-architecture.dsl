/*
 * PALEE CLI — canonical architecture model (Structurizr DSL)
 *
 * Route: architecture-visualization plugin -> system-modeler + c4model.
 * State: CURRENT (Phase 1, @kuldeep2822k/palee v0.5.2, modelled 2026-09-22).
 * Evidence: every element and relationship cites a repo path in its description;
 *           the full evidence register is palee-architecture.evidence.md.
 *
 * This file is the source of truth; rendered PNG/SVG are derived artifacts.
 * View: Qoder Structurizr/C4 preview. Export (needs structurizr-cli on PATH):
 *   structurizr export -workspace architecture/palee-architecture.dsl -view Components -format svg -output architecture/export
 */
workspace "PALEE CLI" "Evidence-backed current-state model for @kuldeep2822k/palee v0.5.2 - deterministic Phase-1 core, no AI, no network" {

    model {

        // ============================== L0 / L1 ==============================
        student = person "Learner (vault owner)" "Runs palee against an Obsidian vault to plan, review and audit study topics. Owns the notes; PALEE never owns them." "actor"

        ci = person "CI runner" "Runs typecheck, lint, node:test and the tarball guard on Node 22/24/26 across ubuntu, windows and macos. Exit codes 0-5 are load-bearing assertions." "actor"

        obsidian = softwareSystem "Obsidian vault" "Markdown notes treated as the canonical database. PALEE reads and rewrites frontmatter and owns a hidden .palee/ working directory inside it." "external-file-store"

        npmregistry = softwareSystem "npm registry" "Publish target for @kuldeep2822k/palee; install source for the only two runtime dependencies, commander and yaml." "external"

        // ============================== L2 / L3 ==============================
        palee = softwareSystem "PALEE CLI" "@kuldeep2822k/palee - SM-2 spaced repetition plus dependency-aware curriculum tool over a Markdown vault. Phase 1 is deterministic and AI-free." {

            process = container "palee CLI process" "One short-lived Node.js >=22 CommonJS process per invocation (bin/palee.ts -> program.parseAsync). No daemon, no server, no native modules, no sockets." "Node.js / CommonJS" "nodeproc" {

                // ---- composition root
                bin = component "Composition root" "bin/palee.ts:1-146 - shebang, commander program, 11 .command() blocks wired to default-exported handlers, top-level catch -> process.exit(5)." "TypeScript module" "c-root"

                // ---- layers (labels mirror the src/ directory names exactly)
                clicommand = component "CLI layer (src/cli)" "13 modules / 3076 lines. One handler per command; loadConfig() + validateVaultPath() preamble, try/catch -> exit code. Also owns per-user config file IO (src/cli/config.ts)." "TypeScript modules" "c-cli"

                typescontract = component "Shared contract (src/types.ts)" "734 lines / 26 importers - widest reach of any module. Single source of truth for shared types (agent.md:11). The runtime shape is the FLAT LoadedTopic; nested Topic/Assessment/Review are Phase-2 reserved (agent.md:54)." "TypeScript module" "c-types"

                enginecore = component "Engine layer (src/engine)" "5 modules / 1430 lines, fs-free (no fs import anywhere under src/engine). SM-2 scheduling, four-pillar mastery, DAG analysis. No Date.now(), no Math.random()." "TypeScript modules" "c-engine"

                storagecore = component "Storage layer (src/storage)" "13 modules / 3758 lines - largest layer by code volume. All vault IO: walker, CST frontmatter, directory-mutex locks, atomic OCC writes, mtime/SHA-256 cache, session and hot-memory persistence, roadmap and pattern parsers." "TypeScript modules" "c-storage"

                validationcore = component "Validation layer (src/validation)" "26 modules / 3072 lines - largest layer by file count. collectVault() one-read pass, runRules() over a 19-rule deterministic catalog, human and JSON formatters. Absent from agent.md's 'Architecture (four layers)' heading." "TypeScript modules" "c-validation"

                publicapi = component "Public package API (src/index.ts)" "src/index.ts:11-26 - version plus export * of the types, engine, storage and validation barrels. The only supported library entry point for consumers." "TypeScript module" "c-public"

                cmdlinelib = component "commander" "v15 - argument and option parsing, help output. One of only two runtime dependencies (agent.md:16)." "npm package" "c-lib"

                yamllib = component "yaml" "v2 - parseDocument CST, used to preserve frontmatter comments, key order and unknown keys byte-for-byte." "npm package" "c-lib"
            }

            configstore = container "Per-user config file" "PALEE_CONFIG_DIR override, else %LOCALAPPDATA%\\palee\\config.json on win32 or ~/.config/palee/config.json on POSIX. Written with raw fs inside src/cli/config.ts:104-126 - not by the storage layer." "JSON file" "store" {
                location "Composite"
            }

            vaultdir = container "Vault notes + .palee working dir" "Topic notes (*.md with flat frontmatter); canonical .palee/sessions/S-*.md; derived .palee/index.md and .palee/hot.md; lock dirs .palee/locks/<sha256>.lockdir/." "Markdown / YAML frontmatter" "store" {
                location "Composite"
            }
        }

        // ============================ relationships ===========================
        student -> palee "Runs 11 deterministic commands; reads plain-text or --json output; branches on documented exit codes 0-5." "CLI"

        ci -> process "npm run typecheck / lint / test / build / pack plus scripts/verify-tarball.js" "shell"

        bin -> clicommand "12 import edges: registers every command handler (bin/palee.ts:13-23)" "in-process import"

        clicommand -> typescontract "11 import edges — the *Options interfaces and data-model types. All are plain imports, not `import type`" "in-process import"
        clicommand -> storagecore "10 of 12 handlers import through the storage barrel src/storage/index.ts" "in-process import"
        clicommand -> enginecore "8 import edges, all DEEP (engine/sm2, engine/mastery, engine/dependency); none go through src/engine/index.ts" "in-process import"
        clicommand -> validationcore "22 import edges from src/cli/validate.ts alone - the 19 rules are imported one by one, not through the validation barrel" "in-process import"
        clicommand -> configstore "loadConfig() reads and saveConfig() writes with raw fs (src/cli/config.ts:59, 104-126)" "file IO"

        validationcore -> storagecore "12 edges - collectVault reuses walkVault, loadTopics, parseFrontmatter and the session readers" "in-process import"
        validationcore -> enginecore "7 edges - no-dependency-cycle uses detectCyclesBounded (:13), no-missing-dependency uses findMissingDependencies (:32), valid-topic-mastery uses computeTopicMastery (:27), and four schema/identity rules import constants from engine/topic-id" "in-process import"
        validationcore -> typescontract "3 edges, all `import type` - ValidationIssue, TopicNode. 32 of the repo's 33 `import type` edges sit in this layer" "in-process import (type-only)"

        enginecore -> typescontract "2 edges - Topic, TopicNode, Review, Assessment (plain imports)" "in-process import"
        storagecore -> typescontract "9 edges - LockData, CacheEntry, FrontmatterResult, WalkOptions, LoadedTopic (plain imports)" "in-process import"
        storagecore -> yamllib "parseDocument and document.toString() for CST-preserving frontmatter updates" "library call"
        clicommand -> cmdlinelib "command, argument and option declarations wired in the composition root" "library call"

        publicapi -> typescontract "export * from the types module" "in-process re-export"
        publicapi -> enginecore "export * from ./engine" "in-process re-export"
        publicapi -> storagecore "export * from ./storage" "in-process re-export"
        publicapi -> validationcore "export * from ./validation" "in-process re-export"

        storagecore -> vaultdir "walkVault reads; atomicWrite writes (temp file + fsync + rename) under Lock protection with a SHA-256 fingerprint OCC check" "file IO"
        validationcore -> vaultdir "read-only: one collectVault pass; validate never mutates (--fix is a Phase-1 stub)" "file IO (read)"
        palee -> obsidian "Treats the vault as the database; the user keeps editing the same notes in Obsidian between runs" "files"
        palee -> npmregistry "publish (release workflow) and install (commander, yaml)" "https"

        // ===================== asserted absences (not edges) ==================
        // An absent relationship is deliberately not modelled as an edge, because
        // a rendered edge would imply it exists. Verified 2026-09-22 against the
        // 216-edge static import graph in _evidence/import-graph.json; re-check:
        //   node scripts/arch-import-graph.cjs
        //
        //   src/engine     -> src/storage     : 0 edges  (engine stays fs-free)
        //   src/engine     -> src/validation  : 0 edges
        //   src/engine     -> src/cli         : 0 edges
        //   src/storage    -> src/cli         : 0 edges
        //   src/storage    -> src/engine      : 0 edges
        //   src/storage    -> src/validation  : 0 edges
        //   src/validation -> src/cli         : 0 edges
        //   src or bin     -> http/https/net/dns : 0 imports (agent.md:80 forbids sockets in Phase 1)
        //   circular module deps : none - Tarjan SCC over all 60 modules found no component > 1
    }

    views {

        systemLandscape "SystemLandscape" {
            include *
            autoLayout tb
            title "L1 - PALEE in its environment: a vault-resident CLI, not a service"
        }

        container "Containers" {
            include *
            autoLayout tb
            title "L2 - one Node process, two filesystem stores, zero network"
        }

        component "Components" {
            process {
                include *
            }
            autoLayout tb
            title "L3 - the real import graph (216 edges, 33 type-only), colours match src/ directories"
        }

        component "FacadeBypass" {
            process {
                include
                bin -> clicommand
                clicommand -> enginecore
                clicommand -> validationcore
                clicommand -> storagecore
                publicapi -> enginecore
                publicapi -> storagecore
                publicapi -> validationcore
            }
            autoLayout tb
            title "Facade discipline: storage is reached through its barrel, engine and validation are not"
        }

        styles {
            element "actor" {
                shape person
                background #2d6a4f
                color #ffffff
            }
            element "Software System" {
                shape ellipse
                background #1d3557
                color #ffffff
            }
            element "external-file-store" {
                shape cylinder
                background #7f5539
                color #ffffff
            }
            element "external" {
                background #495057
                color #ffffff
                border #adb5bd
            }
            element "nodeproc" {
                background #2b2d42
                color #f8f9fa
            }
            element "store" {
                shape cylinder
                background #6c757d
                color #ffffff
            }
            element "c-lib" {
                shape hexagon
                background #43aa8b
                color #081f1c
            }
            element "c-root" {
                background #9e2a2b
                color #ffffff
            }
            element "c-cli" {
                background #4361ee
                color #ffffff
            }
            element "c-engine" {
                background #7209b7
                color #ffffff
            }
            element "c-storage" {
                background #f72585
                color #06131f
            }
            element "c-validation" {
                background #4cc9f0
                color #06222c
            }
            element "c-types" {
                background #ffd166
                color #241b06
            }
            element "c-public" {
                background #06d6a0
                color #04231a
            }
            relationship "in-process import (type-only)" {
                style dashed
                color #ffd6a5
            }
            relationship "file IO (read)" {
                style dashed
                color #ffcf9e
            }
            relationship "library call" {
                style dashed
                color #90be6d
            }
            relationship "in-process import" {
                color #bde0fe
                thickness 2
            }
            relationship "file IO" {
                color #ffcf9e
                thickness 3
            }
        }
    }
}
