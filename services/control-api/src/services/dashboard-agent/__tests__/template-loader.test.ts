import { describe, expect, it } from 'vitest'
import { loadTemplate } from '../template-loader'

describe('loadTemplate', () => {
  it('returns all template files including src/', async () => {
    const files = await loadTemplate({ appId: 'app_test', apiUrl: 'https://api.example.com' })
    const paths = files.map(f => f.path).sort()
    expect(paths).toContain('package.json')
    expect(paths).toContain('vite.config.ts')
    expect(paths).toContain('index.html')
    expect(paths).toContain('src/main.tsx')
    expect(paths).toContain('src/App.tsx')
    expect(paths).toContain('src/index.css')
    expect(paths).toContain('src/lib/butterbase.ts')
    expect(paths).toContain('.env')
    expect(paths).not.toContain('.env.template')
  })

  it('substitutes APP_ID and API_URL into .env', async () => {
    const files = await loadTemplate({ appId: 'app_abc', apiUrl: 'https://api.butterbase.dev' })
    const env = files.find(f => f.path === '.env')!
    expect(env.content).toContain('VITE_APP_ID=app_abc')
    expect(env.content).toContain('VITE_API_URL=https://api.butterbase.dev')
    expect(env.content).not.toContain('__APP_ID__')
  })

  it('package.json contains only allowlisted deps', async () => {
    const files = await loadTemplate({ appId: 'x', apiUrl: 'x' })
    const pkg = JSON.parse(files.find(f => f.path === 'package.json')!.content)
    const allowlist = new Set([
      'react', 'react-dom', '@butterbase/client', 'tailwindcss', 'autoprefixer', 'postcss',
      'vite', '@vitejs/plugin-react', 'lucide-react', 'clsx', 'tailwind-merge',
      'class-variance-authority', 'typescript',
    ])
    const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
    for (const d of declared) expect(allowlist.has(d)).toBe(true)
  })
})
