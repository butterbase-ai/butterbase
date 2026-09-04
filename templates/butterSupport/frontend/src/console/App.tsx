import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthGate } from './components/AuthGate';
import { AppLayout } from './components/AppLayout';
import { Login } from './routes/Login';
import { NoAccess } from './routes/NoAccess';
import { Setup } from './routes/Setup';
import { Inbox } from './routes/Inbox';
import { TicketDetail } from './routes/TicketDetail';
import { Patterns } from './routes/Patterns';
import { Docs } from './routes/Docs';
import { TeamSettings } from './routes/settings/Team';
import { WidgetSettings } from './routes/settings/Widget';
import { DocsSettings } from './routes/settings/Docs';
import { SkillSettings } from './routes/settings/Skill';
import { AutonomySettings } from './routes/settings/Autonomy';
import { EscalationSettings } from './routes/settings/Escalation';
import { IntegrationsSettings } from './routes/settings/Integrations';
import { AISettings } from './routes/settings/AI';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/no-access" element={<NoAccess />} />
      <Route
        path="/*"
        element={
          <AuthGate>
            <Routes>
              <Route path="/setup" element={<Setup />} />
              <Route element={<AppLayout />}>
                <Route index element={<Navigate to="/inbox" replace />} />
                <Route path="/inbox" element={<Inbox />} />
                <Route path="/inbox/:ticketId" element={<TicketDetail />} />
                <Route path="/patterns" element={<Patterns />} />
                <Route path="/docs" element={<Docs />} />
                <Route path="/settings/team" element={<TeamSettings />} />
                <Route path="/settings/widget" element={<WidgetSettings />} />
                <Route path="/settings/docs" element={<DocsSettings />} />
                <Route path="/settings/skill" element={<SkillSettings />} />
                <Route path="/settings/autonomy" element={<AutonomySettings />} />
                <Route path="/settings/escalation" element={<EscalationSettings />} />
                <Route path="/settings/integrations" element={<IntegrationsSettings />} />
                <Route path="/settings/ai" element={<AISettings />} />
                <Route path="*" element={<Navigate to="/inbox" replace />} />
              </Route>
            </Routes>
          </AuthGate>
        }
      />
    </Routes>
  );
}
