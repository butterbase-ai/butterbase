import { NavLink } from 'react-router-dom';
import { Building2, Users, Calendar, Settings, Mail, Megaphone, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

const items = [
  { to: '/companies', label: 'Companies',   icon: Building2 },
  { to: '/people',    label: 'People',      icon: Users },
  { to: '/leads',     label: 'Lead Finder', icon: Search },
  { to: '/meetings',  label: 'Meetings',    icon: Calendar },
  { to: '/campaigns', label: 'Campaigns',   icon: Mail },
  { to: '/social',    label: 'Social',      icon: Megaphone },
  { to: '/settings',  label: 'Settings',    icon: Settings },
];

export function Sidebar() {
  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col bg-background">
      {/* Wordmark */}
      <div className="px-6 pt-7 pb-9">
        <div className="flex items-baseline gap-1.5">
          <span
            className="font-display text-[28px] leading-none text-foreground"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'wght' 500" }}
          >
            butter
          </span>
          <span className="font-editorial italic text-[28px] leading-none text-butter">
            base
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="h-px w-6 bg-foreground/40" />
          <span className="eyebrow !text-[9.5px]">customer&nbsp;ledger</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 px-3">
        <div className="px-3 pb-2 eyebrow !text-[9.5px]">Workspace</div>
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
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
                  className={cn(
                    'absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[2px] rounded-r-full bg-butter transition-transform origin-left',
                    isActive ? 'scale-x-100' : 'scale-x-0',
                  )}
                />
                <it.icon
                  className={cn(
                    'h-[15px] w-[15px] shrink-0 transition-colors',
                    isActive ? 'text-butter' : 'text-muted-foreground group-hover:text-foreground',
                  )}
                  strokeWidth={1.75}
                />
                <span className="flex-1">{it.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="flex-1" />

      {/* Footer mark */}
      <div className="px-6 pb-6">
        <div className="rule-dotted mb-4" />
        <p className="font-editorial italic text-[13px] leading-snug text-muted-foreground">
          “The work is in the relationships.”
        </p>
        <p className="mt-2 eyebrow !text-[9px]">v2 · paper edition</p>
      </div>
    </aside>
  );
}
