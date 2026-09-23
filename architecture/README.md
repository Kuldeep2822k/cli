# `architecture/` — PALEE architecture, as the code actually is

Produced 2026-09-22 against `@kuldeep2822k/palee` v0.5.2 at commit `d4e02a4`, with the **architecture-visualization** plugin (`system-modeler`, `dependency-impact-analyzer`, `architecture-health`, `architecture-communicator`; `c4model` + `graphviz` as diagram-source foundations).

Everything here is derived from the repo, and the numbers regenerate.

## Start here

| File | Answers | Read if you are… |
| --- | --- | --- |
| [`04-stakeholder-explainer.md`](04-stakeholder-explainer.md) | What is this system, what does one command do, what should a reviewer look at | new to the repo, reviewing it, or explaining it to someone else |
| [`01-architecture-model.md`](01-architecture-model.md) | What the layers and boundaries actually are, and which edges deliberately do **not** exist | about to change structure, or reconciling docs with code |
| [`02-dependency-impact.md`](02-dependency-impact.md) | Coupling, blast radius, per-command reach, a change-impact playbook | planning a specific change and needing to know what it can break |
| [`03-docs-audit-findings.md`](03-docs-audit-findings.md) | 16 evidence-backed doc/diagram defects by severity, plus the Phase-2 items that are **not** defects | updating `agent.md` or the VitePress docs |
| [`palee-architecture.evidence.md`](palee-architecture.evidence.md) | The node/edge evidence register with confidence labels | auditing whether the model is trustworthy |

## Diagram sources (text is canonical; images are derived)

| File | Format | Question it answers |
| --- | --- | --- |
| [`palee-architecture.dsl`](palee-architecture.dsl) | Structurizr DSL | L1 context, L2 containers, L3 components, and a `FacadeBypass` view — four views from one model |
| [`dependency-graph.dot`](dependency-graph.dot) | Graphviz DOT | All **60 modules / 216 import edges**, clustered by layer, border weight = fan-in. A zoom-and-lookup map, not an overview — start with `layer-summary` |
| [`layer-summary.dot`](layer-summary.dot) | Graphviz DOT | The same data collapsed to **6 layer nodes / 18 inter-layer edges** with counts |
| [`validation-detail.dot`](validation-detail.dot) | Graphviz DOT | `src/validation` and everything it touches — the layer no architecture doc names |
| [`boundary-exceptions.dot`](boundary-exceptions.dot) | Graphviz DOT | The 2 rule contradictions, 2 facade divergences and 3 coupling hotspots, each cited to `file:line` |

### Rendered images

Already generated into [`export/`](export/) — each view exists as both `.svg` (zoomable) and `.png`:

[`export/layer-summary.svg`](export/layer-summary.svg) · [`export/boundary-exceptions.svg`](export/boundary-exceptions.svg) · [`export/validation-detail.svg`](export/validation-detail.svg) · [`export/dependency-graph.svg`](export/dependency-graph.svg)


`04-stakeholder-explainer.md` carries Mermaid versions of the layer and `palee review` views, so they render in the existing VitePress site without new tooling.

## Regenerate

```bash
node scripts/arch-import-graph.cjs    # scans src/ + bin/ -> architecture/_evidence/import-graph.{json,md}
node scripts/arch-render-dot.cjs      # graph -> 3 generated .dot views + _evidence/evidence-model.json
node scripts/mermaid-lint.cjs         # structural check of every ```mermaid block in docs/, architecture/, planning/
node scripts/mermaid-lint.cjs --self-test   # proves the linter's checks can actually fail (8/8)
```

All three are read-only against `src/` (boundary-exceptions.dot is hand-maintained); the two `arch-*` scripts only write into `architecture/`.

## Render the diagram sources

Graphviz 16.1.0 (installed here via `winget install Graphviz.Graphviz`; on a fresh machine a new shell is needed before `dot` resolves on `PATH`):

```bash
for f in layer-summary boundary-exceptions dependency-graph validation-detail; do
  dot -Tsvg "architecture/$f.dot" -o "architecture/export/$f.svg"
  dot -Tpng -Gdpi=110 "architecture/$f.dot" -o "architecture/export/$f.png"
done
```

All four render with **no Graphviz warnings**, and each output was inspected as an image — cluster titles, node labels and edge colours all resolve. Two layout notes, because they were real findings rather than preferences: the dense module views use `rankdir=LR` (top-to-bottom put ~19 same-rank modules in one row and produced an unreadable 4000 px-wide strip), and cluster fills must be spelled-out light hex values via `fillcolor` — Graphviz 16 ignored both 8-digit `#RRGGBBAA` suffixes and `bgcolor` on clusters, painting them with the saturated border colour and making white-on-white labels.

The Structurizr model has **not** been rendered — `structurizr-cli` needs a JVM and was not installed. Open [`palee-architecture.dsl`](palee-architecture.dsl) with Qoder's Structurizr/C4 viewer instead; if that preview rejects the file, report the message and fix the DSL source rather than a render.

## Status of the verification

* **Checked:** 0 circular imports and 0 forbidden-direction edges across 216 edges; all 276 `sourceRef`s in the evidence model resolve; 53 Mermaid blocks in `docs/` structurally clean (linter self-test 8/8); all four DOT views rendered warning-free and visually inspected; every `file:line` cited in the findings read directly from source.
* **Not checked:** `typecheck`/`lint`/`test` were not executed for this audit, the DSL was never machine-parsed, and there is no runtime observation — `coverage/` could feed that next.

