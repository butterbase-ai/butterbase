import type { ReactNode } from 'react';

export const metadata = {
  title: 'butterbase-build-runner-e2e-fixture',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
