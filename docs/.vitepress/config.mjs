// Documentation site for docs.gryffi.com (VitePress). The troubleshooting page
// and the user guide are generated first: npm run build runs scripts/generate.mjs.
import { readFileSync, existsSync } from 'node:fs';
import { defineConfig } from 'vitepress';

const guidePath = new URL('./guide.json', import.meta.url);
const guide = existsSync(guidePath) ? JSON.parse(readFileSync(guidePath, 'utf8')) : [];

export default defineConfig({
  title: 'Gryffi Docs',
  description: 'Install, run and use Gryffi Community Edition',
  lang: 'en',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', href: '/icon.png' }]],
  themeConfig: {
    logo: { light: '/logo.png', dark: '/logo-dark.png' },
    siteTitle: false,
    nav: [
      { text: 'Install', link: '/install/' },
      { text: 'Run', link: '/operations/' },
      { text: 'User guide', link: '/guide/' },
      { text: 'Troubleshooting', link: '/troubleshooting/' }
    ],
    sidebar: {
      '/guide/': [{ text: 'User guide', link: '/guide/' }, ...guide],
      '/': [
        {
          text: 'Install and set up',
          items: [
            { text: 'Install', link: '/install/' },
            { text: 'Settings and .env', link: '/configuration/' },
            { text: 'AI providers', link: '/ai/' },
            { text: 'Email', link: '/email/' }
          ]
        },
        {
          text: 'Run',
          items: [
            { text: 'Updates and backups', link: '/operations/' },
            { text: 'Troubleshooting', link: '/troubleshooting/' }
          ]
        },
        { text: 'User guide', link: '/guide/' }
      ]
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/lloydstellar/gryffi' }],
    editLink: {
      pattern: 'https://github.com/lloydstellar/gryffi/edit/main/docs/:path',
      text: 'Suggest a change to this page'
    },
    search: { provider: 'local' },
    footer: {
      message: 'Gryffi Community Edition is open source under the AGPL-3.0.',
      copyright: 'Gryffi and the Gryffi logo are trademarks of Gryffi.'
    }
  }
});
