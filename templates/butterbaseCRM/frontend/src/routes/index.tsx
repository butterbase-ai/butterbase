import { Routes, Route, Navigate } from 'react-router-dom';
import Login from '@/pages/Login';
import OAuthCallback from '@/pages/OAuthCallback';
import AgentOnboarding from '@/pages/AgentOnboarding';
import CompaniesList from '@/pages/CompaniesList';
import CompanyDetail from '@/pages/CompanyDetail';
import PeopleList from '@/pages/PeopleList';
import PersonDetail from '@/pages/PersonDetail';
import DealsKanban from '@/pages/DealsKanban';
import Meetings from '@/pages/Meetings';
import Campaigns from '@/pages/Campaigns';
import SocialPosts from '@/pages/SocialPosts';
import Settings from '@/pages/Settings';
import AcceptInvite from '@/pages/AcceptInvite';
import Terms from '@/pages/Terms';
import Privacy from '@/pages/Privacy';
import LeadFinder from '@/pages/LeadFinder';
import { AuthGuard } from './AuthGuard';
import { WorkspaceGuard } from './WorkspaceGuard';
import { AppShell } from '@/components/AppShell';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<OAuthCallback />} />
      <Route path="/auth/callback/integration/:toolkit" element={<OAuthCallback />} />
      <Route path="/invite/:token" element={<AcceptInvite />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />

      <Route element={<AuthGuard />}>
        <Route path="/onboard" element={<AgentOnboarding />} />

        <Route element={<WorkspaceGuard />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<Navigate to="/companies" replace />} />
            <Route path="/companies" element={<CompaniesList />} />
            <Route path="/companies/:id" element={<CompanyDetail />} />
            <Route path="/people" element={<PeopleList />} />
            <Route path="/people/:id" element={<PersonDetail />} />
            <Route path="/leads" element={<LeadFinder />} />
            <Route path="/deals" element={<DealsKanban />} />
            <Route path="/meetings" element={<Meetings />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/social" element={<SocialPosts />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
