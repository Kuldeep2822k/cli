import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(
  defineConfig({
    base: '/cli/',
    title: 'PALEE CLI',
    description: 'Personal Active Learning & Evaluation Engine — Smart, AI-powered study tracker for Obsidian vaults.',
    lastUpdated: true,
    cleanUrls: true,

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
      siteTitle: '⚡ PALEE CLI',
      
      nav: [
        { text: 'Guide', link: '/01-0-overview' },
        { text: 'Commands', link: '/02-0-cli-commands' },
        { text: 'Engine', link: '/03-0-engine-core' },
        { text: 'Storage', link: '/04-0-storage-layer' },
        { text: 'Architecture', link: '/01-2-architecture-overview' },
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
          text: '1. Overview & Architecture',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/01-0-overview' },
            { text: '1.1 Getting Started', link: '/01-1-getting-started' },
            { text: '1.2 Architecture Overview', link: '/01-2-architecture-overview' }
          ]
        },
        {
          text: '2. CLI Commands Reference',
          collapsed: false,
          items: [
            { text: 'Commands Overview', link: '/02-0-cli-commands' },
            { text: '2.1 Topic Management', link: '/02-1-topic-management-commands' },
            { text: '2.2 Review & Scheduling', link: '/02-2-review-and-scheduling-commands' },
            { text: '2.3 Reporting & Validation', link: '/02-3-reporting-commands' },
            { text: '2.4 Session Management', link: '/02-4-session-management-command' }
          ]
        },
        {
          text: '3. Learning Engine',
          collapsed: false,
          items: [
            { text: 'Engine Core', link: '/03-0-engine-core' },
            { text: '3.1 SM-2 Algorithm', link: '/03-1-sm2-spaced-repetition-algorithm' },
            { text: '3.2 Dependency Graph & DAG', link: '/03-2-dependency-graph-engine' }
          ]
        },
        {
          text: '4. Storage Layer',
          collapsed: false,
          items: [
            { text: 'Storage Overview', link: '/04-0-storage-layer' },
            { text: '4.1 Frontmatter & Atomic Writes', link: '/04-1-frontmatter-parser-and-atomic-writes' },
            { text: '4.2 File Locking & Concurrency', link: '/04-2-file-locking' },
            { text: '4.3 Vault Walker & Cache', link: '/04-3-vault-walker-and-file-cache' },
            { text: '4.4 Session Memory (hot.md)', link: '/04-4-session-memory-storage' }
          ]
        },
        {
          text: '5. Data Model & Types',
          collapsed: false,
          items: [
            { text: 'Data Model Overview', link: '/05-0-data-model-and-types' },
            { text: '5.1 Topic & Assessment Schema', link: '/05-1-topic-and-assessment-schema' },
            { text: '5.2 Configuration & CLI Types', link: '/05-2-configuration-and-cli-option-types' }
          ]
        },
        {
          text: '6. Testing Strategy',
          collapsed: false,
          items: [
            { text: 'Testing Overview', link: '/06-0-testing' },
            { text: '6.1 Unit Tests', link: '/06-1-unit-tests' },
            { text: '6.2 Integration & Smoke Tests', link: '/06-2-integration-and-smoke-tests' }
          ]
        },
        {
          text: '7. CI/CD & Delivery',
          collapsed: false,
          items: [
            { text: 'CI/CD Overview', link: '/07-0-cicd-and-release-pipeline' },
            { text: '7.1 Continuous Integration', link: '/07-1-continuous-integration' },
            { text: '7.2 Release & NPM Publishing', link: '/07-2-release-workflow-and-npm-publishing' }
          ]
        },
        {
          text: '8. Planning & Specifications',
          collapsed: false,
          items: [
            { text: 'Planning Documents Index', link: '/08-0-planning-and-design-documents' },
            { text: '8.1 Phase 1 Specifications', link: '/08-1-phase-1-specification-and-invariants' },
            { text: '8.2 Future: AI Module & Phase 2', link: '/08-2-future-ai-module-and-phase-2-design' }
          ]
        },
        {
          text: 'Glossary & Reference',
          collapsed: false,
          items: [
            { text: 'Glossary', link: '/09-glossary' }
          ]
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
