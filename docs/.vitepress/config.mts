import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(
  defineConfig({
    base: '/cli/',
    title: 'PALEE CLI',
    description: 'Personal Active Learning & Evaluation Engine — Smart, AI-powered study tracker for Obsidian vaults.',
    lastUpdated: true,
    cleanUrls: true,

    head: [
      ['link', { rel: 'icon', type: 'image/png', href: '/cli/favicon.png' }],
      ['link', { rel: 'icon', type: 'image/svg+xml', href: '/cli/palee-logo.svg' }]
    ],

    mermaid: {
      theme: 'base',
      themeVariables: {
        background: '#000000',
        primaryColor: '#000000',
        primaryTextColor: '#e0e0e0',
        primaryBorderColor: '#2d3139',
        lineColor: '#5a606b',
        secondaryColor: '#000000',
        tertiaryColor: '#000000',
        clusterBkg: '#0a0b0d',
        clusterBorder: '#1e2128',
        titleColor: '#8b949e',
        edgeLabelBackground: '#000000',
        fontFamily: 'Inter, system-ui, sans-serif'
      }
    },

    themeConfig: {
      logo: '/palee-logo.png',
      siteTitle: 'PALEE CLI',
      
      nav: [
        { text: 'Overview', link: '/01-0-overview' },
        { text: 'CLI Commands', link: '/02-0-cli-commands' },
        { text: 'Engine Core', link: '/03-0-engine-core' },
        { text: 'Storage Layer', link: '/04-0-storage-layer' },
        { text: 'Architecture', link: '/01-2-architecture-overview' },
        { text: 'ADRs', link: '/adr/README' },
        { text: 'Glossary', link: '/09-glossary' },
        {
          text: 'v0.2.0',
          items: [
            { text: 'Changelog', link: 'https://github.com/Kuldeep2822k/cli/blob/main/CHANGELOG.md' },
            { text: 'GitHub Releases', link: 'https://github.com/Kuldeep2822k/cli/releases' },
            { text: 'npm package', link: 'https://www.npmjs.com/package/@kuldeep2822k/palee' }
          ]
        }
      ],

      sidebar: [
        {
          text: 'Overview',
          link: '/01-0-overview',
          items: [
            { text: 'Getting Started', link: '/01-1-getting-started' },
            { text: 'Architecture Overview', link: '/01-2-architecture-overview' }
          ]
        },
        {
          text: 'CLI Commands',
          link: '/02-0-cli-commands',
          items: [
            { text: 'Topic Management Commands', link: '/02-1-topic-management-commands' },
            { text: 'Review and Scheduling Commands', link: '/02-2-review-and-scheduling-commands' },
            { text: 'Reporting Commands', link: '/02-3-reporting-commands' },
            { text: 'Session Management Command', link: '/02-4-session-management-command' }
          ]
        },
        {
          text: 'Engine Core',
          link: '/03-0-engine-core',
          items: [
            { text: 'SM-2 Spaced Repetition Algorithm', link: '/03-1-sm2-spaced-repetition-algorithm' },
            { text: 'Dependency Graph Engine', link: '/03-2-dependency-graph-engine' }
          ]
        },
        {
          text: 'Storage Layer',
          link: '/04-0-storage-layer',
          items: [
            { text: 'Frontmatter Parser and Atomic Writes', link: '/04-1-frontmatter-parser-and-atomic-writes' },
            { text: 'File Locking', link: '/04-2-file-locking' },
            { text: 'Vault Walker and File Cache', link: '/04-3-vault-walker-and-file-cache' },
            { text: 'Session Memory Storage', link: '/04-4-session-memory-storage' }
          ]
        },
        {
          text: 'Data Model and Types',
          link: '/05-0-data-model-and-types',
          items: [
            { text: 'Topic and Assessment Schema', link: '/05-1-topic-and-assessment-schema' },
            { text: 'Configuration and CLI Option Types', link: '/05-2-configuration-and-cli-option-types' }
          ]
        },
        {
          text: 'Testing',
          link: '/06-0-testing',
          items: [
            { text: 'Unit Tests', link: '/06-1-unit-tests' },
            { text: 'Integration and Smoke Tests', link: '/06-2-integration-and-smoke-tests' }
          ]
        },
        {
          text: 'CI/CD and Release Pipeline',
          link: '/07-0-cicd-and-release-pipeline',
          items: [
            { text: 'Continuous Integration', link: '/07-1-continuous-integration' },
            { text: 'Release Workflow and NPM Publishing', link: '/07-2-release-workflow-and-npm-publishing' }
          ]
        },
        {
          text: 'Planning and Design Documents',
          link: '/08-0-planning-and-design-documents',
          items: [
            { text: 'Phase 1 Specification and Invariants', link: '/08-1-phase-1-specification-and-invariants' },
            { text: 'Future AI Module and Phase 2 Design', link: '/08-2-future-ai-module-and-phase-2-design' }
          ]
        },
        {
          text: 'Architectural Decision Records',
          link: '/adr/README',
          items: [
            { text: 'ADR-0001: SM-2 Spaced Repetition', link: '/adr/0001-supermemo-sm2-algorithm' },
            { text: 'ADR-0002: Atomic File Locking & OCC', link: '/adr/0002-atomic-file-locking-and-occ' },
            { text: 'ADR-0003: Frontmatter via YAML Document API', link: '/adr/0003-concrete-syntax-tree-yaml-frontmatter' },
            { text: 'ADR-0004: Four-Pillar Pedagogical Model', link: '/adr/0004-four-pillar-pedagogical-mastery' }
          ]
        },
        {
          text: 'Glossary',
          link: '/09-glossary'
        }
      ],

      search: {
        provider: 'local'
      },

      socialLinks: [
        { icon: 'github', link: 'https://github.com/Kuldeep2822k/cli' },
        { icon: 'npm', link: 'https://www.npmjs.com/package/@kuldeep2822k/palee' }
      ],

      footer: {
        message: 'Released under the MIT License.',
        copyright: 'Copyright © 2026 Kuldeep Kumar. Powered by VitePress.'
      }
    }
  })
)
