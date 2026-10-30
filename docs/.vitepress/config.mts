import { createRequire } from 'node:module'
import { defineConfig } from 'vitepress'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')

const config = defineConfig({
    base: '/cli/',
    title: 'PALEE CLI',
    description: 'Personal Active Learning & Evaluation Engine — Smart, AI-powered study tracker for Obsidian vaults.',
    lastUpdated: true,
    cleanUrls: true,
    appearance: 'force-dark',
    sitemap: {
      hostname: 'https://kuldeep2822k.github.io',
      transformItems(items) {
        return items.map((item) => ({
          ...item,
          url: item.url === '' ? '/cli/' : `/cli/${item.url.replace(/^\//, '')}`
        }))
      }
    },
    markdown: {
      math: true,
      config(md) {
        const fence = md.renderer.rules.fence
        if (!fence) return
        md.renderer.rules.fence = (tokens, idx, options, env, self) => {
          const token = tokens[idx]
          if (token.info.trim() === 'mermaid') {
            // Expose the unmodified diagram source for the copy control;
            // MermaidZoom renders it into the inner container client-side.
            const graph = encodeURIComponent(token.content)
            return `<div class="mermaid-block" data-graph="${graph}"><div class="mermaid"></div></div>\n`
          }
          return fence(tokens, idx, options, env, self)
        }
      }
    },

    transformHead({ pageData }) {
      const url =
        pageData.relativePath === 'index.md'
          ? 'https://kuldeep2822k.github.io/cli/'
          : `https://kuldeep2822k.github.io/cli/${pageData.relativePath.replace(/\.md$/, '').replace(/\/index$/, '/')}`
      const title = pageData.title ? `${pageData.title} | PALEE CLI` : 'PALEE CLI'
      const description = pageData.description || 'Personal Active Learning & Evaluation Engine for Obsidian vaults.'
      const image = 'https://kuldeep2822k.github.io/cli/palee-logo.png'
      return [
        ['link', { rel: 'canonical', href: url }],
        ['meta', { property: 'og:type', content: 'website' }],
        ['meta', { property: 'og:site_name', content: 'PALEE CLI' }],
        ['meta', { property: 'og:title', content: title }],
        ['meta', { property: 'og:description', content: description }],
        ['meta', { property: 'og:url', content: url }],
        ['meta', { property: 'og:image', content: image }],
        ['meta', { name: 'twitter:card', content: 'summary' }],
        ['meta', { name: 'twitter:title', content: title }],
        ['meta', { name: 'twitter:description', content: description }],
        ['meta', { name: 'twitter:image', content: image }]
      ]
    },

    head: [
      ['link', { rel: 'icon', type: 'image/png', href: '/cli/favicon.png' }]
    ],

    themeConfig: {
      logo: '/palee-logo.png',
      siteTitle: 'PALEE CLI',
      
      nav: [
        { text: 'Overview', link: '/01-0-overview' },
        { text: 'CLI Commands', link: '/02-0-cli-commands' },
        { text: 'Engine Core', link: '/03-0-engine-core' },
        { text: 'Storage Layer', link: '/04-0-storage-layer' },
        { text: 'ADRs', link: '/adr/README' },
        { text: 'Glossary', link: '/09-glossary' },
        {
          text: `v${pkg.version}`,
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
          link: '/adr/README'
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

      editLink: {
        pattern: 'https://github.com/Kuldeep2822k/cli/edit/main/docs/:path',
        text: 'Edit this page'
      },

      footer: {
        message: 'Released under the MIT License.',
        copyright: 'Copyright © 2026 Kuldeep Kumar. Powered by VitePress.'
      }
    }
})

export default config
