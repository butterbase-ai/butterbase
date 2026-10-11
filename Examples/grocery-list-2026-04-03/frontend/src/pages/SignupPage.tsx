import type { ReactNode } from 'react';
import { useLocale, text, localizedMessage, errorMessage } from '../i18n';
import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { signup } from '../services/auth';

export function SignupPage() {
  useLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<ReactNode>('');
  const [success, setSuccess] = useState<ReactNode>('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (password !== confirmPassword) {
      setError(localizedMessage("Passwords do not match"));
      return;
    }

    if (password.length < 8) {
      setError(localizedMessage("Password must be at least 8 characters"));
      return;
    }

    setLoading(true);

    try {
      const response = await signup(email, password);
      if (response) {
        setSuccess(response.message || localizedMessage('Verification email sent! Please check your email.'));
        // Redirect to login after 3 seconds
        setTimeout(() => navigate('/login'), 3000);
      }
    } catch (err: unknown) {
      const message = errorMessage(err, "Signup failed");
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px' }}>
      <h1>{text("Sign Up")}</h1>
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
        <div style={{ marginBottom: '15px' }}>
          <label htmlFor="confirmPassword" style={{ display: 'block', marginBottom: '5px' }}>{text("Confirm Password")}</label>
          <input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            style={{ width: '100%', padding: '8px' }}
          />
        </div>
        {error && (
          <div style={{ color: 'red', marginBottom: '15px' }}>{error}</div>
        )}
        {success && (
          <div style={{ color: 'green', marginBottom: '15px' }}>{success}</div>
        )}
        <button
          type="submit"
          disabled={loading}
          style={{ width: '100%', padding: '10px', cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          {loading ? text("Signing up...") : text("Sign Up")}
        </button>
      </form>
      <p style={{ marginTop: '20px', textAlign: 'center' }}>{text("Already have an account?")}{' '}<Link to="/login">{text("Login")}</Link>
      </p>
    </div>
  );
}
