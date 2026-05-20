import { describe, it, expect } from 'vitest';
import { renderAuthTemplate, type AuthTemplate } from '../services/partner-proxy/auth-template.js';

describe('renderAuthTemplate', () => {
  it('renders bearer header (Seedance / Z.AI style)', () => {
    const tpl: AuthTemplate = { location: 'header', name: 'Authorization', template: 'Bearer {{key}}' };
    const out = renderAuthTemplate(tpl, 'sk-xyz');
    expect(out).toEqual({ kind: 'header', name: 'Authorization', value: 'Bearer sk-xyz' });
  });

  it('renders raw header (x-api-key style)', () => {
    const tpl: AuthTemplate = { location: 'header', name: 'x-api-key', template: '{{key}}' };
    const out = renderAuthTemplate(tpl, 'abc123');
    expect(out).toEqual({ kind: 'header', name: 'x-api-key', value: 'abc123' });
  });

  it('renders query parameter', () => {
    const tpl: AuthTemplate = { location: 'query', name: 'api_key', template: '{{key}}' };
    const out = renderAuthTemplate(tpl, 'abc123');
    expect(out).toEqual({ kind: 'query', name: 'api_key', value: 'abc123' });
  });

  it('throws on missing {{key}} placeholder', () => {
    const tpl: AuthTemplate = { location: 'header', name: 'Authorization', template: 'Bearer static' };
    expect(() => renderAuthTemplate(tpl, 'k')).toThrow(/key.*placeholder/i);
  });

  it('throws on unknown location', () => {
    const tpl = { location: 'cookie' as any, name: 'x', template: '{{key}}' };
    expect(() => renderAuthTemplate(tpl, 'k')).toThrow(/unknown location/i);
  });

  it('throws on empty key', () => {
    const tpl: AuthTemplate = { location: 'header', name: 'Authorization', template: 'Bearer {{key}}' };
    expect(() => renderAuthTemplate(tpl, '')).toThrow(/empty key/i);
  });
});
