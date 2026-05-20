import { useState, useEffect } from 'react';
import { butterbase } from './lib';
import './App.css';

function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    const { data } = await butterbase.auth.getUser();
    setUser(data);
    setLoading(false);
  }

  async function handleSignUp(email: string, password: string) {
    const { data, error } = await butterbase.auth.signUp({ email, password });
    if (error) {
      alert(error.message);
    } else {
      setUser(data?.user);
    }
  }

  async function handleSignIn(email: string, password: string) {
    const { data, error } = await butterbase.auth.signIn({ email, password });
    if (error) {
      alert(error.message);
    } else {
      setUser(data?.user);
    }
  }

  async function handleSignOut() {
    await butterbase.auth.signOut();
    setUser(null);
  }

  if (loading) {
    return <div>Loading...</div>;
  }

  if (!user) {
    return (
      <div className="App">
        <h1>Welcome to {{PROJECT_NAME}}</h1>
        <p>Powered by Butterbase</p>
        <div>
          <h2>Sign In</h2>
          <form onSubmit={(e) => {
            e.preventDefault();
            const form = e.target as HTMLFormElement;
            const email = (form.elements.namedItem('email') as HTMLInputElement).value;
            const password = (form.elements.namedItem('password') as HTMLInputElement).value;
            handleSignIn(email, password);
          }}>
            <input name="email" type="email" placeholder="Email" required />
            <input name="password" type="password" placeholder="Password" required />
            <button type="submit">Sign In</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      <h1>Welcome, {user.email}!</h1>
      <button onClick={handleSignOut}>Sign Out</button>
    </div>
  );
}

export default App;
