import { LanguagePicker, uiText, useUiLocale } from "../i18n";
import { Link } from 'react-router-dom';

export default function Privacy() {
  useUiLocale();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="fixed bottom-4 right-4 z-50 rounded bg-background p-1"><LanguagePicker /></div>
      <div className="mx-auto max-w-3xl px-6 py-16">
        <Link to="/" className="text-sm text-muted-foreground hover:underline">
          {uiText("← butterbaseCRM")}</Link>

        <h1 className="mt-6 text-3xl font-semibold tracking-tight">{uiText("Privacy Policy")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{uiText("Last updated: June 17, 2026")}</p>

        <div className="mt-10 space-y-8 text-sm leading-6">
          <section>
            <h2 className="text-lg font-semibold">{uiText("1. Who we are")}</h2>
            <p className="mt-2">
              {uiText("butterbaseCRM (the \"Service\") is a customer relationship management application. This policy explains what data we collect, how we use it, and the choices you have.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("2. Data we collect")}</h2>
            <ul className="mt-2 list-disc space-y-1 pl-6">
              <li>
                <strong>{uiText("Account data:")}</strong> {uiText(" email address, display name, and password hash you provide at sign-up.")}</li>
              <li>
                <strong>{uiText("CRM data you create:")}</strong> {uiText(" companies, people, deals, notes, activities, campaigns, meetings, and other records you add.")}</li>
              <li>
                <strong>{uiText("Connected-account data:")}</strong> {uiText(" when you connect a third-party account (Gmail, Google Calendar, LinkedIn, Reddit, X), we store the OAuth tokens needed to act on your behalf, plus the metadata of items you author through the Service (e.g., the post ID and send time of an X post you publish from butterbaseCRM).")}</li>
              <li>
                <strong>{uiText("Usage data:")}</strong> {uiText(" standard server logs (IP address, request path, timestamp) used to operate and secure the Service.")}</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("3. How we use data")}</h2>
            <ul className="mt-2 list-disc space-y-1 pl-6">
              <li>{uiText("To operate the Service — render your CRM, send your messages, publish your posts.")}</li>
              <li>{uiText("To authenticate you and secure your account.")}</li>
              <li>{uiText("To debug, prevent abuse, and improve the Service.")}</li>
              <li>{uiText("To communicate with you about your account.")}</li>
            </ul>
            <p className="mt-2">
              {uiText("We do not sell your data. We do not use your CRM data or connected-account data to train third-party AI models. AI features inside the Service only process the records you explicitly act on, and only for the duration of that action.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("4. Third-party platforms")}</h2>
            <p className="mt-2">
              {uiText("When you connect a third-party account, we receive the data the platform's OAuth consent screen tells you we will receive. For X specifically: we read your basic profile (username, user id) once at connection time to show which account is linked, and we publish or delete posts only when you explicitly trigger those actions inside the Service. We do not read your timeline, scrape public posts, run sentiment or trend analysis, or share X data with third parties.")}</p>
            <p className="mt-2">
              {uiText("We use Composio (composio.dev) as the OAuth and action-execution layer for these integrations. Composio stores connection tokens on our behalf.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("5. Sub-processors")}</h2>
            <p className="mt-2">
              {uiText("We rely on the following sub-processors to operate the Service:")}</p>
            <ul className="mt-2 list-disc space-y-1 pl-6">
              <li>{uiText("Butterbase (butterbase.ai) — hosting, database, file storage, AI gateway.")}</li>
              <li>{uiText("Composio (composio.dev) — third-party OAuth and tool execution.")}</li>
              <li>{uiText("Recall.ai — meeting bots that join calls when you enable the notetaker.")}</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("6. Retention")}</h2>
            <p className="mt-2">
              {uiText("We retain your account and CRM data for as long as your account is active. When you disconnect a third-party integration, we delete the OAuth tokens for that connection. When you delete your account, we delete your CRM data and tokens within 30 days (server logs may persist for up to 90 days for security purposes).")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("7. Your rights")}</h2>
            <p className="mt-2">
              {uiText("You can view, edit, or delete your data from the Service at any time. You can disconnect any integration from the Settings page. To request a full export or account deletion, contact us at the address below.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("8. Security")}</h2>
            <p className="mt-2">
              {uiText("Data is transmitted over TLS and stored on managed infrastructure with access controls. No system is perfectly secure; if a breach occurs that affects your data, we will notify you in accordance with applicable law.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("9. Children")}</h2>
            <p className="mt-2">
              {uiText("The Service is not directed to children under 13, and we do not knowingly collect data from them.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("10. Changes")}</h2>
            <p className="mt-2">
              {uiText("We may update this policy. Material changes will be communicated through the Service.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("11. Contact")}</h2>
            <p className="mt-2">
              {uiText("Privacy questions or data requests: ")}<a className="underline" href="mailto:kcflexigbo@gmail.com">{uiText("kcflexigbo@gmail.com")}</a>.
            </p>
          </section>
        </div>

        <div className="mt-12 border-t pt-6 text-sm text-muted-foreground">
          <Link to="/terms" className="hover:underline">{uiText("Terms of Service")}</Link>
        </div>
      </div>
    </div>
  );
}
