import { uiText, uiMessage, useUiLocale } from "../i18n";
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
        get title() { return uiText('Go to the X Developer Portal'); },
        body: (
          <>
            {uiText("Open ")}<a className="underline" href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noreferrer">{uiText("developer.x.com/portal/dashboard")}</a>{' '}
            {uiText("and create (or open) a ")}<strong>{uiText("Project")}</strong> {uiText(" and an ")}<strong>{uiText("App")}</strong> {uiText(" inside it.")}</>
        ),
      },
      {
        get title() { return uiText('Set up User authentication'); },
        body: (
          <ul className="list-disc space-y-1 pl-5">
            <li>{uiText("Open your App → ")}<strong>{uiText("User authentication settings")}</strong> → <em>{uiText("Set up")}</em>.</li>
            <li>{uiText("App permissions: ")}<strong>{uiText("Read and write")}</strong> {uiText(" (add Direct Messages if you want DM tools later).")}</li>
            <li>{uiText("Type of App: ")}<strong>{uiText("Web App, Automated App or Bot")}</strong> {uiText(" (confidential client).")}</li>
          </ul>
        ),
      },
      {
        get title() { return uiText('Paste this callback URL into the X form'); },
        body: <CopyField label={uiText("Callback URI / Redirect URL")} value={CALLBACK_URL} />,
      },
      {
        get title() { return uiText('Set your website + ToS + Privacy URLs'); },
        body: (
          <ul className="list-disc space-y-1 pl-5">
            <li>{uiText("Website URL: ")}<code className="rounded bg-gray-100 px-1">{window.location.origin}</code></li>
            <li>{uiText("Terms of Service: ")}<code className="rounded bg-gray-100 px-1">{window.location.origin}/terms</code></li>
            <li>{uiText("Privacy Policy: ")}<code className="rounded bg-gray-100 px-1">{window.location.origin}/privacy</code></li>
          </ul>
        ),
      },
      {
        get title() { return uiText('Save, then grab three values from "Keys and tokens"'); },
        body: (
          <>
            {uiText("After saving the User authentication settings, the ")}<strong>{uiText("Keys and tokens")}</strong> {uiText(" tab will show:")}<ul className="mt-1 list-disc space-y-1 pl-5">
              <li><strong>{uiText("OAuth 2.0 Client ID")}</strong> + <strong>{uiText("Client Secret")}</strong> {uiText(" (under ")}<em>{uiText("OAuth 2.0 Client ID and Client Secret")}</em>).</li>
              <li><strong>{uiText("Bearer Token")}</strong> {uiText(" (under ")}<em>{uiText("Authentication Tokens")}</em>).</li>
            </ul>
            {uiText("Paste all three into the form below.")}</>
        ),
      },
    ]
  }
  if (slug === 'linkedin') {
    return [
      {
        get title() { return uiText('Go to the LinkedIn Developers portal'); },
        body: (
          <>
            {uiText("Open ")}<a className="underline" href="https://www.linkedin.com/developers/apps" target="_blank" rel="noreferrer">{uiText("linkedin.com/developers/apps")}</a> {uiText(" and create an App.")}</>
        ),
      },
      {
        get title() { return uiText('Add the "Sign In with LinkedIn using OpenID Connect" product'); },
        body: (
          <>
            {uiText("Products tab → request ")}<strong>{uiText("Sign In with LinkedIn using OpenID Connect")}</strong> {uiText(" and ")}<strong>{uiText("Share on LinkedIn")}</strong>{uiText(". Approval is usually instant.")}</>
        ),
      },
      {
        get title() { return uiText('Add this redirect URL'); },
        body: (
          <>
            {uiText("Auth tab → ")}<strong>{uiText("OAuth 2.0 settings")}</strong> {uiText(" → Authorized redirect URLs:")}<CopyField label={uiText("Redirect URL")} value={CALLBACK_URL} />
          </>
        ),
      },
      {
        get title() { return uiText('Copy the Client ID and Client Secret'); },
        body: (
          <>
            {uiText("Auth tab → ")}<em>{uiText("Application credentials")}</em>{uiText(". Paste them below.")}</>
        ),
      },
    ]
  }
  if (slug === 'tiktok') {
    return [
      {
        get title() { return uiText('Go to the TikTok for Developers portal'); },
        body: (
          <>
            {uiText("Open ")}<a className="underline" href="https://developers.tiktok.com/apps/" target="_blank" rel="noreferrer">{uiText("developers.tiktok.com/apps")}</a> {uiText(" and create (or open) an App.")}</>
        ),
      },
      {
        get title() { return uiText('Enable Login Kit and Content Posting API'); },
        body: (
          <ul className="list-disc space-y-1 pl-5">
            <li>{uiText("Under ")}<strong>{uiText("Products")}</strong>{uiText(", add ")}<strong>{uiText("Login Kit")}</strong> {uiText(" (for web).")}</li>
            <li>{uiText("Add ")}<strong>{uiText("Content Posting API")}</strong> {uiText(" if you want to publish videos.")}</li>
            <li>{uiText("Set scopes: ")}<code className="rounded bg-gray-100 px-1">user.info.basic</code>, <code className="rounded bg-gray-100 px-1">video.publish</code>, <code className="rounded bg-gray-100 px-1">video.upload</code>.</li>
          </ul>
        ),
      },
      {
        get title() { return uiText('Add this redirect URI'); },
        body: <CopyField label={uiText("Redirect URI")} value={CALLBACK_URL} />,
      },
      {
        get title() { return uiText('Copy Client Key and Client Secret'); },
        body: (
          <>
            {uiText("From your App's ")}<strong>{uiText("Manage apps")}</strong> {uiText(" page → ")}<em>{uiText("App info")}</em>{uiText(". The ")}<strong>{uiText("Client key")}</strong> {uiText(" maps to Client ID below; ")}<strong>{uiText("Client secret")}</strong> {uiText(" maps to Client Secret.")}</>
        ),
      },
    ]
  }
  return [
    {
      get title() { return uiText('Go to Reddit App preferences'); },
      body: (
        <>
          {uiText("Open ")}<a className="underline" href="https://www.reddit.com/prefs/apps" target="_blank" rel="noreferrer">{uiText("reddit.com/prefs/apps")}</a> {uiText(" and click ")}<strong>{uiText("create app")}</strong>.
        </>
      ),
    },
    {
      get title() { return uiText('Choose "web app" and fill in the fields'); },
      body: (
        <ul className="list-disc space-y-1 pl-5">
          <li>{uiText("Type: ")}<strong>{uiText("web app")}</strong>.</li>
          <li>{uiText("name: ")}<em>{uiText("butterbaseCRM")}</em> {uiText(" (or anything you like).")}</li>
          <li>{uiText("about url: ")}<code className="rounded bg-gray-100 px-1">{window.location.origin}</code></li>
        </ul>
      ),
    },
    {
      get title() { return uiText('Set the redirect URI'); },
      body: <CopyField label={uiText("redirect uri")} value={CALLBACK_URL} />,
    },
    {
      get title() { return uiText('Copy the credentials'); },
      body: (
        <>
          {uiText("After save, the small string under ")}<em>{uiText("web app")}</em> {uiText(" at the top of the card is your ")}<strong>{uiText("Client ID")}</strong>{uiText(". The \"")}<em>{uiText("secret")}</em>{uiText("\" line is your ")}<strong>{uiText("Client Secret")}</strong>{uiText(". Paste both below.")}</>
      ),
    },
  ]
}

function CopyField({ label, value }: { label: string; value: string }) {
  useUiLocale();
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
            toast.success(uiText('Copied'))
          }}
          className="rounded border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50"
        >
          {uiText("Copy")}</button>
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
  const uiLocale = useUiLocale();
  const steps = useMemo(() => makeSteps(slug), [slug, uiLocale])
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [bearerToken, setBearerToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const needsBearer = slug === 'twitter'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error(uiText('Client ID and Client Secret are required'))
      return
    }
    if (needsBearer && !bearerToken.trim()) {
      toast.error(uiText('Bearer Token is required for X / Twitter'))
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
      toast.success(uiMessage`${slug} credentials saved — workspace members can now connect their accounts.`)
      setClientId(''); setClientSecret(''); setBearerToken('')
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : uiText('Failed to save credentials'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4 border-t border-gray-100 bg-gray-50/60 p-4 text-sm leading-6">
      <div>
        <h4 className="font-semibold">{uiText("Use your own developer app")}</h4>
        <p className="text-xs text-gray-600">
          {uiText("The default credentials work, but you can plug in your own — useful if you're forking this CRM for your own company, want full rate-limit headroom, or need the consent screen to show your brand. Only workspace owners / admins can do this.")}</p>
      </div>

      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="rounded-md border border-gray-200 bg-white p-3 text-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              {uiText("Step ")}{i + 1}
            </div>
            <div className="mt-1 text-sm font-medium text-gray-900">{step.title}</div>
            <div className="mt-2 text-gray-700">{step.body}</div>
          </li>
        ))}
      </ol>

      <form onSubmit={handleSubmit} className="space-y-3 rounded-md border border-blue-200 bg-white p-3">
        <div className="text-sm font-semibold text-gray-900">{uiText("Paste your credentials")}</div>
        <div>
          <label className="text-xs font-medium text-gray-700">{uiText("Client ID")}</label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={slug === 'twitter' ? uiText('e.g. UkVQTEFDRV9NRV9DTElFTlRfSUQ6MTpjaQ') : uiText('Client ID')}
            className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-sm font-mono"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700">{uiText("Client Secret")}</label>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={uiText("Client Secret")}
            className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-sm font-mono"
          />
          <p className="mt-1 text-[11px] text-gray-500">
            {uiText("Sent over TLS, encrypted at rest on Butterbase. Rotate any secret you've ever pasted into a chat transcript before saving.")}</p>
        </div>
        {needsBearer && (
          <div>
            <label className="text-xs font-medium text-gray-700">{uiText("Application Bearer Token")}</label>
            <input
              type="password"
              value={bearerToken}
              onChange={(e) => setBearerToken(e.target.value)}
              placeholder={uiText("AAAAAAAAAAAAAAAAAAAAA…")}
              className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-sm font-mono"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              {uiText("From X's \"Authentication Tokens\" section (separate from the OAuth 2.0 keys). Required by Composio even if you only plan to post.")}</p>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? uiText('Saving…') : uiText('Save credentials')}
          </button>
        </div>
      </form>
    </div>
  )
}
