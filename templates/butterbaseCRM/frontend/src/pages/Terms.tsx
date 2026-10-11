import { LanguagePicker, uiText, useUiLocale } from "../i18n";
import { Link } from 'react-router-dom';

export default function Terms() {
  useUiLocale();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="fixed bottom-4 right-4 z-50 rounded bg-background p-1"><LanguagePicker /></div>
      <div className="mx-auto max-w-3xl px-6 py-16">
        <Link to="/" className="text-sm text-muted-foreground hover:underline">
          {uiText("← butterbaseCRM")}</Link>

        <h1 className="mt-6 text-3xl font-semibold tracking-tight">{uiText("Terms of Service")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{uiText("Last updated: June 17, 2026")}</p>

        <div className="mt-10 space-y-8 text-sm leading-6">
          <section>
            <h2 className="text-lg font-semibold">{uiText("1. Acceptance")}</h2>
            <p className="mt-2">
              {uiText("By creating an account or using butterbaseCRM (the \"Service\"), you agree to these Terms of Service. If you do not agree, do not use the Service.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("2. The Service")}</h2>
            <p className="mt-2">
              {uiText("butterbaseCRM is a customer relationship management application. It lets you store records about companies and people, schedule outreach, and connect third-party accounts (such as Gmail, Google Calendar, LinkedIn, Reddit, and X) to send messages or publish posts on your behalf.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("3. Your Account")}</h2>
            <p className="mt-2">
              {uiText("You are responsible for safeguarding your login credentials and for everything that happens under your account. Notify us immediately if you suspect unauthorized access.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("4. Acceptable Use")}</h2>
            <p className="mt-2">{uiText("You agree not to use the Service to:")}</p>
            <ul className="mt-2 list-disc space-y-1 pl-6">
              <li>{uiText("send unsolicited bulk messages, spam, or harassment;")}</li>
              <li>{uiText("impersonate any person or misrepresent your affiliation;")}</li>
              <li>{uiText("violate the terms of any connected third-party platform (including X, Gmail, LinkedIn, Reddit);")}</li>
              <li>{uiText("scrape, mirror, or redistribute third-party platform data outside what you are authorized to do;")}</li>
              <li>{uiText("upload malware or attempt to disrupt the Service.")}</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("5. Third-Party Integrations")}</h2>
            <p className="mt-2">
              {uiText("When you connect an external account (e.g., your X account), you authorize butterbaseCRM to act on that account through the actions you trigger inside the app. Your use of those accounts also remains subject to that platform's own terms. You can disconnect any integration from the Settings page at any time.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("6. Content")}</h2>
            <p className="mt-2">
              {uiText("You retain ownership of the content you upload (contacts, notes, messages, etc.). You grant us a limited license to store and process that content solely to operate the Service for you.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("7. Termination")}</h2>
            <p className="mt-2">
              {uiText("You may stop using the Service and delete your account at any time. We may suspend or terminate accounts that violate these Terms.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("8. Disclaimer")}</h2>
            <p className="mt-2">
              {uiText("The Service is provided \"as is\" without warranties of any kind. We do not guarantee that the Service will be uninterrupted, error-free, or suitable for any particular purpose.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("9. Limitation of Liability")}</h2>
            <p className="mt-2">
              {uiText("To the maximum extent permitted by law, butterbaseCRM is not liable for any indirect, incidental, or consequential damages arising out of your use of the Service.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("10. Changes")}</h2>
            <p className="mt-2">
              {uiText("We may update these Terms. Material changes will be communicated through the Service. Continued use after changes constitutes acceptance.")}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{uiText("11. Contact")}</h2>
            <p className="mt-2">
              {uiText("Questions about these Terms: ")}<a className="underline" href="mailto:kcflexigbo@gmail.com">{uiText("kcflexigbo@gmail.com")}</a>.
            </p>
          </section>
        </div>

        <div className="mt-12 border-t pt-6 text-sm text-muted-foreground">
          <Link to="/privacy" className="hover:underline">{uiText("Privacy Policy")}</Link>
        </div>
      </div>
    </div>
  );
}
