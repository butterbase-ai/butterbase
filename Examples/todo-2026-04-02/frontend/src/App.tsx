import { LocalePicker } from './components/LocalePicker';
import { useLocale, text } from './i18n';
import './i18n.css';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { TodosPage } from './pages/TodosPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  useLocale();
  const { user, loading } = useAuth();

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '50px' }}>{text("Loading...")}</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  useLocale();
  const { user, loading } = useAuth();

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '50px' }}>{text("Loading...")}</div>;
  }

  if (user) {
    return <Navigate to="/todos" replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  useLocale();
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route
        path="/signup"
        element={
          <PublicRoute>
            <SignupPage />
          </PublicRoute>
        }
      />
      <Route
        path="/todos"
        element={
          <ProtectedRoute>
            <TodosPage />
          </ProtectedRoute>
        }
      />
      <Route path="/" element={<Navigate to="/todos" replace />} />
    </Routes>
  );
}

function App() {
  useLocale();
  return (
    <BrowserRouter>
      <AuthProvider>
        <LocalePicker title="Todo App" />
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
