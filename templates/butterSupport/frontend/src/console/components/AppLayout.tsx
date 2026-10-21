import { LanguagePicker, uiText, useUiLocale } from "../../i18n";
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Inbox as InboxIcon,
  Sparkles,
  LogOut,
  BookOpen,
  Users,
  MessageSquare,
  FileText,
  AlertOctagon,
  Brain,
  Wrench,
  Bot,
  Plug,
  type LucideIcon,
} from 'lucide-react';
import { bb, SUBDOMAIN } from '@/console/lib/bb';
import { useAuth } from './AuthGate';
import { cn } from '@/console/lib/utils';
import { SupportOverviewPanel } from './SupportOverviewPanel';

interface NavItemDef {
  to: string;
  label: string;
  icon: LucideIcon;
  num: string;
}

const WORKSPACE: NavItemDef[] = [
  { to: '/inbox',    get label() { return uiText('Inbox'); },    icon: InboxIcon, num: '01' },
  { to: '/patterns', get label() { return uiText('Patterns'); }, icon: Sparkles,  num: '02' },
  { to: '/docs',     get label() { return uiText('Docs'); },     icon: BookOpen,  num: '03' },
];

const CONFIGURE: NavItemDef[] = [
  { to: '/settings/team',         get label() { return uiText('Team'); },         icon: Users,         num: '04' },
  { to: '/settings/widget',       get label() { return uiText('Widget'); },       icon: MessageSquare, num: '05' },
  { to: '/settings/docs',         get label() { return uiText('Knowledge'); },    icon: FileText,      num: '06' },
  { to: '/settings/escalation',   get label() { return uiText('Escalation'); },   icon: AlertOctagon,  num: '07' },
  { to: '/settings/ai',           get label() { return uiText('AI Models'); },    icon: Brain,         num: '08' },
  { to: '/settings/skill',        get label() { return uiText('Skills'); },       icon: Wrench,        num: '09' },
  { to: '/settings/autonomy',     get label() { return uiText('Autonomy'); },     icon: Bot,           num: '10' },
  { to: '/settings/integrations', get label() { return uiText('Integrations'); }, icon: Plug,          num: '11' },
];

function NavItem({ to, icon: Icon, label, num }: NavItemDef) {
  useUiLocale();
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-3 rounded-md px-3 py-2 text-[13.5px] transition-all',
          isActive
            ? 'bg-foreground/[0.04] text-foreground font-medium'
            : 'text-muted-foreground hover:bg-foreground/[0.025] hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden
            className={cn(
              'absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[2px] rounded-r-full bg-butter transition-transform origin-left',
              isActive ? 'scale-x-100' : 'scale-x-0',
            )}
          />
          <Icon
            className={cn(
              'h-[15px] w-[15px] shrink-0 transition-colors',
              isActive ? 'text-butter' : 'text-muted-foreground group-hover:text-foreground',
            )}
            strokeWidth={1.75}
          />
          <span className="flex-1">{uiText(label)}</span>
          <span className="font-mono text-[10px] text-muted-foreground/70 num">{num}</span>
        </>
      )}
    </NavLink>
  );
}

function Topbar({ onSignOut, email }: { onSignOut: () => void; email?: string }) {
  useUiLocale();
  const initials = email?.split('@')[0]?.slice(0, 2).toUpperCase() || '?';
  return (
    <header className="relative flex h-16 items-center gap-4 px-5">
      <LanguagePicker />
      <div className="flex-1" />
      <SupportOverviewPanel />
      <div className="hidden md:flex items-center gap-2">
        <div className="h-7 w-7 grid place-items-center rounded-full bg-butter/15 text-foreground text-[10px] font-semibold ring-1 ring-border">
          {initials}
        </div>
        <button
          onClick={onSignOut}
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
          title={uiText("Sign out")}
        >
          <LogOut className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="absolute inset-x-0 bottom-0 rule-dotted" />
    </header>
  );
}

export function AppLayout() {
  useUiLocale();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  async function signOut() {
    try { await bb.auth.signOut(); } catch { /* ignore */ }
    navigate('/login', { replace: true });
  }

  return (
    <div className="paper-grain flex h-screen bg-background text-foreground">
      <aside className="hidden md:flex w-64 shrink-0 flex-col bg-background">
        {/* Wordmark */}
        <div className="px-6 pt-7 pb-9">
          <div className="flex items-baseline gap-1.5">
            <span
              className="font-display text-[28px] leading-none text-foreground"
              style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'wght' 500" }}
            >{uiText("butter")}</span>
            <span className="font-editorial italic text-[28px] leading-none text-butter">{uiText("support")}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="h-px w-6 bg-foreground/40" />
            <span className="eyebrow !text-[9.5px]">{uiText("support console")}</span>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5 px-3">
          <div className="px-3 pb-2 eyebrow !text-[9.5px]">{uiText("Workspace")}</div>
          {WORKSPACE.map((it) => <NavItem key={it.to} {...it} />)}

          <div className="px-3 pt-5 pb-2 eyebrow !text-[9.5px]">{uiText("Configure")}</div>
          {CONFIGURE.map((it) => <NavItem key={it.to} {...it} />)}
        </nav>

        <div className="flex-1" />

        <div className="px-6 pb-6">
          <div className="rule-dotted mb-4" />
          <p className="font-editorial italic text-[13px] leading-snug text-muted-foreground">
            {uiText("\"The work is in the conversation.\"")}</p>
          <p className="mt-2 eyebrow !text-[9px]">v1 · {SUBDOMAIN}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col border-l border-border">
        <Topbar onSignOut={signOut} email={user?.email} />
        <main className="min-h-0 flex-1 overflow-auto">
          <div key={location.pathname} className="animate-rise h-full">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
