import { useState } from 'react'
import { toast } from 'sonner'
import { bb } from '../lib/butterbase'
import { useSocialConnections } from '../hooks/useSocialConnections'
import { XIcon, LinkedInIcon, RedditIcon, InstagramIcon, TikTokIcon } from '@/components/SocialIcons'
import { SocialSetupWizard } from '@/components/SocialSetupWizard'

const META = {
  twitter: {
    name: 'Twitter / X',
    blurb: "We'll redirect you to x.com to authorize butterbaseCRM. You stay signed in to your X account; we never see your password.",
    permissions: ['Read your profile (handle, name)', 'Post on your behalf', 'Delete posts you sent through this CRM'],
  },
  linkedin: {
    name: 'LinkedIn',
    blurb: "We'll redirect you to linkedin.com to authorize butterbaseCRM. We only receive what LinkedIn's consent screen shows you.",
    permissions: ['Read your profile (name, headline)', 'Share posts on your personal feed'],
  },
  reddit: {
    name: 'Reddit',
    blurb: "We'll redirect you to reddit.com to authorize butterbaseCRM. Your password is never shared with us.",
    permissions: ['Read your username and karma', 'Submit posts to subreddits you choose', 'List subreddit flairs'],
  },
  instagram: {
    name: 'Instagram',
    blurb: "We'll redirect you to instagram.com to authorize butterbaseCRM. You stay signed in to your Instagram account; we never see your password.",
    permissions: ['Read your profile (username, name)', 'Publish posts and reels on your behalf'],
    composioManaged: true as const,
  },
  tiktok: {
    name: 'TikTok',
    blurb: "We'll redirect you to tiktok.com to authorize butterbaseCRM. Your password is never shared with us.",
    permissions: ['Read your profile (username, display name)', 'Upload and publish videos on your behalf'],
  },
} as const

const UPCOMING: ReadonlySet<Slug> = new Set(['instagram', 'tiktok'])

type Slug = keyof typeof META

interface Props {
  workspace_id: string | null
}

export function SocialConnectionsPanel({ workspace_id }: Props) {
  const { data: connections = [], refetch } = useSocialConnections(workspace_id)
  const [connectingSlug, setConnectingSlug] = useState<Slug | null>(null)
  const [expandedSlug, setExpandedSlug] = useState<Slug | null>(null)
  const [setupSlug, setSetupSlug] = useState<Slug | null>(null)
  const [showHelp, setShowHelp] = useState(false)

  const lookup = new Map(connections.map((c) => [c.toolkit_slug, c]))

  async function handleConnect(slug: Slug) {
    setConnectingSlug(slug)
    try {
      // Instagram is Composio-managed — register the toolkit (no BYO creds) before starting OAuth
      if (slug === 'instagram' && workspace_id) {
        const { error: cfgErr } = await bb.functions.invoke('configure-social-toolkit', {
          body: { workspace_id, toolkit: 'instagram' },
        })
        if (cfgErr) throw cfgErr
      }
      const redirectUrl = `${window.location.origin}/auth/callback/integration/${slug}`
      const { data, error } = await bb.integrations.connect(slug, { redirectUrl })
      if (error) throw error
      if (!data?.authUrl) throw new Error('No authorisation URL returned')
      window.location.href = data.authUrl
    } catch (e) {
      setConnectingSlug(null)
      toast.error(e instanceof Error ? e.message : `Could not start ${META[slug].name} connection`)
    }
  }

  async function handleDisconnect(slug: Slug) {
    if (!workspace_id) return
    try {
      await bb.functions
        .invoke('unregister-integration', { body: { workspace_id, toolkit: slug } })
        .catch(() => undefined)
      toast.success(`${META[slug].name} disconnected`)
      refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Disconnect failed')
    }
  }

  return (
    <section className="space-y-3">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Social accounts</h3>
          <p className="text-sm text-gray-500">
            Connect your workspace's social accounts. All workspace members can post from connected accounts.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          className="rounded border border-gray-200 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          {showHelp ? 'Hide help' : 'How this works'}
        </button>
      </header>

      {showHelp && (
        <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-xs leading-5 text-blue-900">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Click <strong>Connect</strong> next to a platform.
            </li>
            <li>
              You'll be redirected to that platform's sign-in / consent page in the same tab — sign
              in with the account you want to post from.
            </li>
            <li>
              Review the permissions and click <strong>Authorize</strong> on the platform's page.
            </li>
            <li>
              You'll be sent back here automatically. The status will flip to{' '}
              <strong>Connected</strong> and a green dot appears.
            </li>
            <li>
              From there, the Social Posts page can publish to all connected accounts at once.
            </li>
          </ol>
          <p className="mt-2 text-blue-800/80">
            Heads up: butterbaseCRM never sees your password. You stay signed in to the platform —
            only the access token comes back to us, and you can disconnect any account here at any
            time.
          </p>
        </div>
      )}

      {(Object.keys(META) as Slug[]).map((slug) => {
        const meta = META[slug]
        const conn = lookup.get(slug)
        const isConnected = conn?.status === 'active'
        const isConnecting = connectingSlug === slug
        const isExpanded = expandedSlug === slug
        const isUpcoming = UPCOMING.has(slug)
        return (
          <div
            key={slug}
            className={`rounded-lg border border-gray-200 bg-white ${isUpcoming ? 'opacity-60' : ''}`}
            aria-disabled={isUpcoming || undefined}
          >
            <div className="flex items-center gap-3 p-3">
              <span className={`relative flex h-9 w-9 items-center justify-center rounded-lg ${
                slug === 'twitter' ? 'bg-black text-white' :
                slug === 'linkedin' ? 'bg-[#0A66C2] text-white' :
                slug === 'instagram' ? 'bg-[#E1306C] text-white' :
                slug === 'tiktok' ? 'bg-black text-white' :
                'bg-[#FF4500] text-white'
              }`}>
                {slug === 'twitter' && <XIcon className="h-5 w-5" />}
                {slug === 'linkedin' && <LinkedInIcon className="h-5 w-5" />}
                {slug === 'reddit' && <RedditIcon className="h-5 w-5" />}
                {slug === 'instagram' && <InstagramIcon className="h-5 w-5" />}
                {slug === 'tiktok' && <TikTokIcon className="h-5 w-5" />}
                {isConnected && (
                  <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-green-500" />
                )}
              </span>
              <div className="flex-1">
                <div className="text-sm font-semibold">{meta.name}</div>
                <div className="text-xs text-gray-500">
                  {isUpcoming
                    ? 'Coming soon'
                    : isConnected
                    ? `Connected${conn?.is_my_connection === false ? ' by a teammate' : ''}${conn?.connected_at ? ' · ' + new Date(conn.connected_at).toLocaleDateString() : ''}`
                    : 'Not connected'}
                </div>
              </div>
              {isUpcoming ? (
                <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                  Upcoming
                </span>
              ) : null}
              {!isUpcoming && !isConnected && (
                <>
                  <button
                    type="button"
                    onClick={() => setExpandedSlug(isExpanded ? null : slug)}
                    className="text-xs text-gray-500 hover:text-gray-900"
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? 'Hide details' : 'What does this do?'}
                  </button>
                  {slug !== 'instagram' && (
                    <button
                      type="button"
                      onClick={() => setSetupSlug(setupSlug === slug ? null : slug)}
                      className="text-xs text-gray-500 hover:text-gray-900"
                      aria-expanded={setupSlug === slug}
                      title="Plug in your own developer app credentials"
                    >
                      {setupSlug === slug ? 'Hide setup' : 'Use my own app'}
                    </button>
                  )}
                </>
              )}
              {isUpcoming ? null : isConnected ? (
                <button
                  type="button"
                  onClick={() => handleDisconnect(slug)}
                  className="rounded border border-gray-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleConnect(slug)}
                  disabled={isConnecting}
                  className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {isConnecting ? 'Redirecting…' : 'Connect'}
                </button>
              )}
            </div>

            {!isUpcoming && !isConnected && isExpanded && (
              <div className="border-t border-gray-100 bg-gray-50/60 px-3 py-2 text-xs leading-5 text-gray-700">
                <p>{meta.blurb}</p>
                <p className="mt-2 font-medium text-gray-900">You'll be asked to allow:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {meta.permissions.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <p className="mt-2 text-gray-500">
                  Disconnect anytime — that revokes our access immediately.
                </p>
              </div>
            )}

            {isConnecting && (
              <div className="border-t border-gray-100 bg-blue-50/60 px-3 py-2 text-xs leading-5 text-blue-900">
                Redirecting you to {meta.name}… if nothing happens, check that your browser allows
                redirects from this site and{' '}
                <button
                  type="button"
                  onClick={() => handleConnect(slug)}
                  className="underline hover:no-underline"
                >
                  try again
                </button>
                .
              </div>
            )}

            {setupSlug === slug && workspace_id && slug !== 'instagram' && (
              <SocialSetupWizard
                slug={slug}
                workspaceId={workspace_id}
                onDone={() => {
                  setSetupSlug(null)
                  refetch()
                }}
              />
            )}
          </div>
        )
      })}
    </section>
  )
}
