import { createRequire } from 'node:module'
import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import type { Plugin } from 'vite'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')

/**
 * The Mermaid plugin registers its renderer synchronously, which pulls every
 * diagram parser into the entry chunk and preloads ~1 MB on pages with no
 * diagrams. Replace the registration with an async component so Rollup emits
 * Mermaid as a separate chunk that loads only when a page renders one.
 */
function lazyMermaid(): Plugin {
  return {
    name: 'docs-lazy-mermaid',
    enforce: 'post',
    transform(code, id) {
      if (!id.includes('vitepress/dist/client/app/index.js')) return

      const hadDefineAsyncComponent = /\bdefineAsyncComponent\b/.test(code)
      let out = code
        .replace(/^import Mermaid from 'vitepress-plugin-mermaid\/Mermaid\.vue';\r?\n/m, '')
        .replace(
          /app\.component\("Mermaid", Mermaid\);/,
          'app.component("Mermaid", defineAsyncComponent(() => import("vitepress-plugin-mermaid/Mermaid.vue")));'
        )

      if (out === code) return
      if (!hadDefineAsyncComponent) {
        out = `import { defineAsyncComponent } from 'vue';\n${out}`
      }
      return { code: out, map: null }
    }
  }
}

const config = withMermaid(
  defineConfig({
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
      math: true
    },

    vite: {
      optimizeDeps: {
        // lazyMermaid() below creates the dynamic import after Vite's dependency
        // scanner has run, so Mermaid is never discovered on its own. Pre-bundle
        // it explicitly: its CommonJS dependency fastdom has no ESM default
        // export, and serving it raw leaves every diagram stuck on "Loading...".
        include: ['mermaid']
      }
    },

    transformHtml(code) {
      // The async Mermaid component is only resolved on pages that contain a
      // diagram; drop Vite's eager preload so other pages never download it.
      return code.replace(/<link rel="modulepreload" href="[^"]*\/Mermaid\.[^"]*\.js"[^>]*>\s*/g, '')
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
        fontSize: '14px',
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
)

config.vite ??= {}
config.vite.plugins ??= []
config.vite.plugins.push(lazyMermaid())

export default config
