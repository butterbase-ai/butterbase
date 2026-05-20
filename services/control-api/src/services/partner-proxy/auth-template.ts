export interface AuthTemplate {
  location: 'header' | 'query';
  name: string;
  template: string; // must contain '{{key}}' literal
}

export type RenderedAuth =
  | { kind: 'header'; name: string; value: string }
  | { kind: 'query'; name: string; value: string };

export function renderAuthTemplate(tpl: AuthTemplate, key: string): RenderedAuth {
  if (!key) throw new Error('renderAuthTemplate: empty key');
  if (!tpl.template.includes('{{key}}')) {
    throw new Error('renderAuthTemplate: template missing {{key}} placeholder');
  }
  const value = tpl.template.replace('{{key}}', key);

  if (tpl.location === 'header') return { kind: 'header', name: tpl.name, value };
  if (tpl.location === 'query') return { kind: 'query', name: tpl.name, value };
  throw new Error(`renderAuthTemplate: unknown location ${(tpl as any).location}`);
}
