import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getBaseUrl, getHeaders } from '../api-client.js';

export function registerBilling(server: McpServer) {
  server.tool(
    'manage_billing',
    `Manage billing, plans, usage, and spending caps for the Butterbase platform account.

This is a platform-scoped tool — it operates on the authenticated account, not on a specific app.

Actions:
  - "status":    Get current plan, usage summary, and spending cap in one call
  - "portal":    Generate a Stripe billing portal URL for payment method / invoice management
  - "topup":     Add credit to the account balance (prepaid top-up)
  - "cap_get":   Retrieve the current monthly spending cap
  - "cap_raise": Raise the monthly spending cap by a given amount
  - "plans":     List all available subscription plans with pricing
  - "usage":     Query detailed metered usage for a date range and optional meter type

Parameters by action:
  status:    { action: "status" }
  portal:    { action: "portal" }
  topup:     { action: "topup", amount: <number in USD cents> }
  cap_get:   { action: "cap_get" }
  cap_raise: { action: "cap_raise", raise_by: <number in USD cents> }
  plans:     { action: "plans" }
  usage:     { action: "usage", start_date?: "YYYY-MM-DD", end_date?: "YYYY-MM-DD", meter?: "compute" | "storage" | ... }

Examples:

  Check current plan and balance:
    Input:  { action: "status" }
    Output: { plan: "pro", balance_cents: 5000, spending_cap_cents: 20000, usage: { ... } }

  Open billing portal:
    Input:  { action: "portal" }
    Output: { url: "https://billing.stripe.com/session/..." }

  Top up $25:
    Input:  { action: "topup", amount: 2500 }
    Output: { success: true, new_balance_cents: 7500 }

  Get current spending cap:
    Input:  { action: "cap_get" }
    Output: { spending_cap_cents: 20000 }

  Raise spending cap by $50:
    Input:  { action: "cap_raise", raise_by: 5000 }
    Output: { spending_cap_cents: 25000 }

  List available plans:
    Input:  { action: "plans" }
    Output: [{ id: "free", name: "Free", ... }, { id: "pro", name: "Pro", ... }]

  Query compute usage for April 2025:
    Input:  { action: "usage", start_date: "2025-04-01", end_date: "2025-04-30", meter: "compute" }
    Output: { usage: [{ date: "2025-04-01", value: 1234 }, ...] }

Common errors:
  - AUTH_INSUFFICIENT_PERMISSIONS: Must be authenticated as the account owner
  - INSUFFICIENT_BALANCE: Account balance too low for top-up operation
  - INVALID_AMOUNT: amount / raise_by must be a positive integer (cents)`,
    {
      action: z
        .enum(['status', 'portal', 'topup', 'cap_get', 'cap_raise', 'plans', 'usage'])
        .describe('The billing action to perform'),
      amount: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Amount in USD cents (required for "topup")'),
      raise_by: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Amount in USD cents to raise the spending cap by (required for "cap_raise")'),
      start_date: z
        .string()
        .optional()
        .describe('Start date for usage query in YYYY-MM-DD format (used with "usage")'),
      end_date: z
        .string()
        .optional()
        .describe('End date for usage query in YYYY-MM-DD format (used with "usage")'),
      meter: z
        .string()
        .optional()
        .describe('Meter type to filter usage by, e.g. "compute", "storage" (used with "usage")'),
    },
    {
      title: 'Manage Billing',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const { action, amount, raise_by, start_date, end_date, meter } = args;

      switch (action) {
        case 'status': {
          const res = await fetch(`${getBaseUrl()}/dashboard/billing`, {
            headers: getHeaders(),
          });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }

        case 'portal': {
          const res = await fetch(`${getBaseUrl()}/dashboard/billing/portal`, {
            method: 'POST',
            headers: getHeaders(),
          });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }

        case 'topup': {
          if (amount === undefined) {
            return {
              content: [{ type: 'text' as const, text: 'Error: "amount" (in USD cents) is required for the "topup" action.' }],
              isError: true,
            };
          }
          const res = await fetch(`${getBaseUrl()}/dashboard/billing/topup`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ amount }),
          });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }

        case 'cap_get': {
          const res = await fetch(`${getBaseUrl()}/dashboard/billing/spending-cap`, {
            headers: getHeaders(),
          });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }

        case 'cap_raise': {
          if (raise_by === undefined) {
            return {
              content: [{ type: 'text' as const, text: 'Error: "raise_by" (in USD cents) is required for the "cap_raise" action.' }],
              isError: true,
            };
          }
          const res = await fetch(`${getBaseUrl()}/dashboard/billing/spending-cap`, {
            method: 'PUT',
            headers: getHeaders(),
            body: JSON.stringify({ raiseBy: raise_by }),
          });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }

        case 'plans': {
          const res = await fetch(`${getBaseUrl()}/dashboard/plans`, {
            headers: getHeaders(),
          });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }

        case 'usage': {
          const params = new URLSearchParams();
          if (start_date) params.set('startDate', start_date);
          if (end_date) params.set('endDate', end_date);
          if (meter) params.set('meterType', meter);
          const qs = params.toString() ? `?${params.toString()}` : '';
          const res = await fetch(`${getBaseUrl()}/dashboard/usage${qs}`, {
            headers: getHeaders(),
          });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }
      }
    }
  );
}
