import { LanguagePicker, DocumentLanguage, uiText, useUiLocale } from "./i18n";
import { useState, useEffect } from 'react';
import { butterbase } from './lib';
import './App.css';

function App() {
  useUiLocale();
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
    return <div>{uiText("Loading...")}</div>;
  }

  if (!user) {
    return (
      <div className="App">
        <DocumentLanguage /><LanguagePicker />
        <h1>{uiText("Welcome to ")}{{PROJECT_NAME}}</h1>
        <p>{uiText("Powered by Butterbase")}</p>
        <div>
          <h2>{uiText("Sign In or Sign Up")}</h2>
          <form onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const email = (form.elements.namedItem('email') as HTMLInputElement).value;
            const password = (form.elements.namedItem('password') as HTMLInputElement).value;
            const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            if (submitter?.value === 'signup') {
              handleSignUp(email, password);
            } else {
              handleSignIn(email, password);
            }
          }}>
            <input name="email" type="email" placeholder={uiText("Email")} required />
            <input name="password" type="password" placeholder={uiText("Password")} required />
            <button type="submit" value="signin">{uiText("Sign In")}</button>
            <button type="submit" value="signup">{uiText("Sign Up")}</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="App">
        <DocumentLanguage /><LanguagePicker />
      <h1>{uiText("Welcome, ")}{user.email}!</h1>
      <button onClick={handleSignOut}>{uiText("Sign Out")}</button>
    </div>
  );
}

export default App;
