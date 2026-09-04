import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { AgentDrawer } from './agent/AgentDrawer';
import { FLAGS, isFlagEnabled } from '../lib/featureFlags';

export function AppShell() {
  const aiEnabled = isFlagEnabled(FLAGS.aiAssistant);
  return (
    <div className="paper-grain flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col border-l border-border">
        <Topbar />
        <main className="min-h-0 flex-1 overflow-auto">
          <div key={location.pathname} className="animate-rise h-full">
            <Outlet />
          </div>
        </main>
      </div>
      {aiEnabled && <AgentDrawer />}
    </div>
  );
}
