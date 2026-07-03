/**
 * URL guard for partner-proxy base URLs.
 *
 * Hardens against SSRF: rejects any URL whose scheme is not lowercase `https://`
 * or whose host is a literal private/loopback/link-local IP address (IPv4 or IPv6),
 * or the literal hostname `localhost`. This is a hostname-level check only — we
 * intentionally do not perform DNS lookups (deferred to the OS at fetch time);
 * the goal is to block the obvious accidents/exploits where an admin pastes a
 * private URL or hand-edits the DB row. Defense-in-depth callers should run this
 * on both write (admin route) and read (forwarder) paths.
 */

function isPrivateIPv4(host: string): boolean {
  // Match dotted-quad only.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const oct = m.slice(1).map((n) => Number(n));
  if (oct.some((n) => n > 255)) return false;
  const [a, b] = oct;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(rawHost: string): boolean {
  // URL hostnames for IPv6 come bracketed: e.g. `[::1]`. URL.hostname strips brackets,
  // but we accept either form here.
  const host = rawHost.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!host.includes(':')) return false;
  // Loopback ::1
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // Unspecified ::
  if (host === '::' || host === '0:0:0:0:0:0:0:0') return true;
  // Link-local fe80::/10
  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
    // first hextet is fe80..febf
    const first = host.split(':')[0];
    if (first.length >= 3) {
      const n = parseInt(first, 16);
      if (n >= 0xfe80 && n <= 0xfebf) return true;
    }
  }
  // Unique local fc00::/7 (fc.. or fd..)
  if (host.startsWith('fc') || host.startsWith('fd')) {
    const first = host.split(':')[0];
    if (first.length >= 2) {
      const n = parseInt(first, 16);
      if (n >= 0xfc00 && n <= 0xfdff) return true;
    }
  }
  // IPv4-mapped ::ffff:127.0.0.1 etc — strip prefix and check IPv4 portion.
  const v4mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4mapped && isPrivateIPv4(v4mapped[1])) return true;
  return false;
}

import { ValidationError } from '../api-errors.js';

export function assertPublicHttpsUrl(urlString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new ValidationError('base_url is not a valid URL');
  }
  // Scheme must be lowercase https://. Reject mixed case, http, etc.
  if (parsed.protocol !== 'https:') {
    throw new Error('base_url must use the https:// scheme');
  }
  if (!urlString.startsWith('https://')) {
    throw new Error('base_url must begin with lowercase "https://"');
  }
  const host = parsed.hostname;
  if (!host) throw new Error('base_url is missing a hostname');
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    throw new ValidationError('base_url host "localhost" is not allowed');
  }
  if (isPrivateIPv4(host)) {
    throw new Error(`base_url host ${host} is a private IPv4 address`);
  }
  if (isPrivateIPv6(host)) {
    throw new Error(`base_url host ${host} is a private IPv6 address`);
  }
}
