import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export type TemplateFile = { path: string; content: string }

const HERE = fileURLToPath(new URL('.', import.meta.url))
// services/control-api/src/services/dashboard-agent → services/dashboard-agent-template
const TEMPLATE_ROOT = join(HERE, '..', '..', '..', '..', '..', 'dashboard-agent-template')

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(full))
    else out.push(full)
  }
  return out
}

export async function loadTemplate(input: { appId: string; apiUrl: string }): Promise<TemplateFile[]> {
  const abs = await walk(TEMPLATE_ROOT)
  const files: TemplateFile[] = []
  for (const a of abs) {
    const rel = relative(TEMPLATE_ROOT, a).replace(/\\/g, '/')
    const raw = await readFile(a, 'utf8')
    if (rel === '.env.template') {
      const content = raw
        .replace(/__APP_ID__/g, input.appId)
        .replace(/__API_URL__/g, input.apiUrl)
      files.push({ path: '.env', content })
    } else {
      files.push({ path: rel, content: raw })
    }
  }
  return files
}
