import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { bb } from '../lib/butterbase'

type Slug = 'twitter' | 'linkedin' | 'reddit' | 'tiktok'

const APP_ID = (import.meta.env.VITE_APP_ID as string | undefined) ?? 'app_44zjayftl7b3'
const CALLBACK_URL = `https://api.butterbase.ai/v1/${APP_ID}/integrations/callback`

interface Step { title: string; body: React.ReactNode }

function makeSteps(slug: Slug): Step[] {
  if (slug === 'twitter') {
    return [
      {
        title: 'Go to the X Developer Portal',
        body: (
          <>
            Open <a className="underline" href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noreferrer">developer.x.com/portal/dashboard</a>{' '}
            and create (or open) a <strong>Project</strong> and an <strong>App</strong> inside it.
          </>
        ),
      },
      {
        title: 'Set up User authentication',
        body: (
          <ul className="list-disc space-y-1 pl-5">
            <li>Open your App → <strong>User authentication settings</strong> → <em>Set up</em>.</li>
            <li>App permissions: <strong>Read and write</strong> (add Direct Messages if you want DM tools later).</li>
            <li>Type of App: <strong>Web App, Automated App or Bot</strong> (confidential client).</li>
          </ul>
        ),
      },
      {
        title: 'Paste this callback URL into the X form',
        body: <CopyField label="Callback URI / Redirect URL" value={CALLBACK_URL} />,
      },
      {
        title: 'Set your website + ToS + Privacy URLs',
        body: (
          <ul className="list-disc space-y-1 pl-5">
            <li>Website URL: <code className="rounded bg-gray-100 px-1">{window.location.origin}</code></li>
            <li>Terms of Service: <code className="rounded bg-gray-100 px-1">{window.location.origin}/terms</code></li>
            <li>Privacy Policy: <code className="rounded bg-gray-100 px-1">{window.location.origin}/privacy</code></li>
          </ul>
        ),
      },
      {
        title: 'Save, then grab three values from "Keys and tokens"',
        body: (
          <>
            After saving the User authentication settings, the <strong>Keys and tokens</strong> tab will show:
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li><strong>OAuth 2.0 Client ID</strong> + <strong>Client Secret</strong> (under <em>OAuth 2.0 Client ID and Client Secret</em>).</li>
              <li><strong>Bearer Token</strong> (under <em>Authentication Tokens</em>).</li>
            </ul>
            Paste all three into the form below.
          </>
        ),
      },
    ]
  }
  if (slug === 'linkedin') {
    return [
      {
        title: 'Go to the LinkedIn Developers portal',
        body: (
          <>
            Open <a className="underline" href="https://www.linkedin.com/developers/apps" target="_blank" rel="noreferrer">linkedin.com/developers/apps</a> and create an App.
          </>
        ),
      },
      {
        title: 'Add the "Sign In with LinkedIn using OpenID Connect" product',
        body: (
          <>
            Products tab → request <strong>Sign In with LinkedIn using OpenID Connect</strong> and <strong>Share on LinkedIn</strong>.
            Approval is usually instant.
          </>
        ),
      },
      {
        title: 'Add this redirect URL',
        body: (
          <>
            Auth tab → <strong>OAuth 2.0 settings</strong> → Authorized redirect URLs:
            <CopyField label="Redirect URL" value={CALLBACK_URL} />
          </>
        ),
      },
      {
        title: 'Copy the Client ID and Client Secret',
        body: (
          <>
            Auth tab → <em>Application credentials</em>. Paste them below.
          </>
        ),
      },
    ]
  }
  if (slug === 'tiktok') {
    return [
      {
        title: 'Go to the TikTok for Developers portal',
        body: (
          <>
            Open <a className="underline" href="https://developers.tiktok.com/apps/" target="_blank" rel="noreferrer">developers.tiktok.com/apps</a> and create (or open) an App.
          </>
        ),
      },
      {
        title: 'Enable Login Kit and Content Posting API',
        body: (
          <ul className="list-disc space-y-1 pl-5">
            <li>Under <strong>Products</strong>, add <strong>Login Kit</strong> (for web).</li>
            <li>Add <strong>Content Posting API</strong> if you want to publish videos.</li>
            <li>Set scopes: <code className="rounded bg-gray-100 px-1">user.info.basic</code>, <code className="rounded bg-gray-100 px-1">video.publish</code>, <code className="rounded bg-gray-100 px-1">video.upload</code>.</li>
          </ul>
        ),
      },
      {
        title: 'Add this redirect URI',
        body: <CopyField label="Redirect URI" value={CALLBACK_URL} />,
      },
      {
        title: 'Copy Client Key and Client Secret',
        body: (
          <>
            From your App's <strong>Manage apps</strong> page → <em>App info</em>. The <strong>Client key</strong> maps to Client ID below; <strong>Client secret</strong> maps to Client Secret.
          </>
        ),
      },
    ]
  }
  return [
    {
      title: 'Go to Reddit App preferences',
      body: (
        <>
          Open <a className="underline" href="https://www.reddit.com/prefs/apps" target="_blank" rel="noreferrer">reddit.com/prefs/apps</a> and click <strong>create app</strong>.
        </>
      ),
    },
    {
      title: 'Choose "web app" and fill in the fields',
      body: (
        <ul className="list-disc space-y-1 pl-5">
          <li>Type: <strong>web app</strong>.</li>
          <li>name: <em>butterbaseCRM</em> (or anything you like).</li>
          <li>about url: <code className="rounded bg-gray-100 px-1">{window.location.origin}</code></li>
        </ul>
      ),
    },
    {
      title: 'Set the redirect URI',
      body: <CopyField label="redirect uri" value={CALLBACK_URL} />,
    },
    {
      title: 'Copy the credentials',
      body: (
        <>
          After save, the small string under <em>web app</em> at the top of the card is your <strong>Client ID</strong>.
          The "<em>secret</em>" line is your <strong>Client Secret</strong>. Paste both below.
        </>
      ),
    },
  ]
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2">
      <div className="text-xs font-medium text-gray-700">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <code className="flex-1 truncate rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-800">
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(value)
            toast.success('Copied')
          }}
          className="rounded border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50"
        >
          Copy
        </button>
      </div>
    </div>
  )
}

interface Props {
  slug: Slug
  workspaceId: string
  onDone: () => void
}

export function SocialSetupWizard({ slug, workspaceId, onDone }: Props) {
  const steps = useMemo(() => makeSteps(slug), [slug])
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [bearerToken, setBearerToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const needsBearer = slug === 'twitter'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error('Client ID and Client Secret are required')
      return
    }
    if (needsBearer && !bearerToken.trim()) {
      toast.error('Bearer Token is required for X / Twitter')
      return
    }
    setSubmitting(true)
    try {
      const { data, error } = await bb.functions.invoke('configure-social-toolkit', {
        body: {
          workspace_id: workspaceId,
          toolkit: slug,
          client_id: clientId.trim(),
          client_secret: clientSecret.trim(),
          ...(needsBearer ? { bearer_token: bearerToken.trim() } : {}),
        },
      })
      if (error) throw error
      const payload = data as { error?: string; upstream?: any; ok?: boolean }
      if (payload?.error) {
        throw new Error(
          payload.upstream?.error?.message ?? payload.error,
        )
      }
      toast.success(`${slug} credentials saved — workspace members can now connect their accounts.`)
      setClientId(''); setClientSecret(''); setBearerToken('')
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save credentials')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4 border-t border-gray-100 bg-gray-50/60 p-4 text-sm leading-6">
      <div>
        <h4 className="font-semibold">Use your own developer app</h4>
        <p className="text-xs text-gray-600">
          The default credentials work, but you can plug in your own — useful if you're forking this CRM for your own
          company, want full rate-limit headroom, or need the consent screen to show your brand. Only workspace
          owners / admins can do this.
        </p>
      </div>

      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="rounded-md border border-gray-200 bg-white p-3 text-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Step {i + 1}
            </div>
            <div className="mt-1 text-sm font-medium text-gray-900">{step.title}</div>
            <div className="mt-2 text-gray-700">{step.body}</div>
          </li>
        ))}
      </ol>

      <form onSubmit={handleSubmit} className="space-y-3 rounded-md border border-blue-200 bg-white p-3">
        <div className="text-sm font-semibold text-gray-900">Paste your credentials</div>
        <div>
          <label className="text-xs font-medium text-gray-700">Client ID</label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={slug === 'twitter' ? 'e.g. UkVQTEFDRV9NRV9DTElFTlRfSUQ6MTpjaQ' : 'Client ID'}
            className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-sm font-mono"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700">Client Secret</label>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Client Secret"
            className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-sm font-mono"
          />
          <p className="mt-1 text-[11px] text-gray-500">
            Sent over TLS, encrypted at rest on Butterbase. Rotate any secret you've ever pasted into a chat
            transcript before saving.
          </p>
        </div>
        {needsBearer && (
          <div>
            <label className="text-xs font-medium text-gray-700">Application Bearer Token</label>
            <input
              type="password"
              value={bearerToken}
              onChange={(e) => setBearerToken(e.target.value)}
              placeholder="AAAAAAAAAAAAAAAAAAAAA…"
              className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-sm font-mono"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              From X's "Authentication Tokens" section (separate from the OAuth 2.0 keys). Required by Composio
              even if you only plan to post.
            </p>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save credentials'}
          </button>
        </div>
      </form>
    </div>
  )
}
