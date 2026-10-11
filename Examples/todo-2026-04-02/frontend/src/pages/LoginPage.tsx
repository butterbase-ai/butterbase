import type { ReactNode } from 'react';
import { useLocale, text, errorMessage } from '../i18n';
import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { login } from '../services/auth';
import { useAuth } from '../contexts/AuthContext';

export function LoginPage() {
  useLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ReactNode>('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login: authLogin } = useAuth();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await login(email, password);
      if (response) {
        await authLogin(response.access_token);
        navigate('/');
      }
    } catch (err: unknown) {
      setError(errorMessage(err, "Login failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px' }}>
      <h1>{text("Login")}</h1>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '15px' }}>
          <label htmlFor="email" style={{ display: 'block', marginBottom: '5px' }}>{text("Email")}</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ width: '100%', padding: '8px' }}
          />
        </div>
        <div style={{ marginBottom: '15px' }}>
          <label htmlFor="password" style={{ display: 'block', marginBottom: '5px' }}>{text("Password")}</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ width: '100%', padding: '8px' }}
          />
        </div>
        {error && (
          <div style={{ color: 'red', marginBottom: '15px' }}>{error}</div>
        )}
        <button
          type="submit"
          disabled={loading}
          style={{ width: '100%', padding: '10px', cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          {loading ? text("Logging in...") : text("Login")}
        </button>
      </form>
      <p style={{ marginTop: '20px', textAlign: 'center' }}>{text("Don't have an account?")}{' '}<Link to="/signup">{text("Sign up")}</Link>
      </p>
    </div>
  );
}
