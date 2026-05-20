import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { getCurrentUser, getStoredToken, setStoredToken, clearStoredToken } from '../services/auth';
import type { User } from '../types';

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      const storedToken = getStoredToken();
      if (storedToken) {
        try {
          const userData = await getCurrentUser(storedToken);
          setUser(userData);
          setToken(storedToken);
        } catch (error) {
          clearStoredToken();
        }
      }
      setLoading(false);
    };

    initAuth();
  }, []);

  const login = async (newToken: string) => {
    setStoredToken(newToken);
    const userData = await getCurrentUser(newToken);
    setUser(userData);
    setToken(newToken);
  };

  const logout = () => {
    clearStoredToken();
    setUser(null);
    setToken(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
