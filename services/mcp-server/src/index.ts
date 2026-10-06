#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createButterbaseMcpServer } from './create-server.js';

/**
 * STDIO ENTRY POINT. Two rules govern this file, and both were broken:
 *
 * 1. STDOUT IS THE JSON-RPC TRANSPORT. Anything written to it that is not a
 *    framed JSON-RPC message is a protocol violation. Tolerant clients skip a
 *    stray line; strict ones fail the handshake. Every human-readable line
 *    this process emits therefore goes to STDERR — console.error, never
 *    console.log. That applies to anything reachable from here, not just this
 *    file (see eligibility-listener.ts).
 *
 * 2. IT MUST START ON THE DOCUMENTED ENV. The documented client-side env is
 *    CONTROL_API_URL + BUTTERBASE_API_KEY. This module used to call
 *    `loadRegionConfig(process.env)` at import purely to print the region in
 *    the banner below, so the process died with
 *    `RegionConfigError: BUTTERBASE_REGIONS env var is not set` before the
 *    transport was ever connected. A client-side stdio process does not route
 *    anything by region — it forwards every call to CONTROL_API_URL, and the
 *    server on the other end owns region selection — so the import is gone
 *    rather than made optional: config this process does not use must not be
 *    able to stop it starting.
 */
console.error('[mcp-server] starting (stdio transport)');

// Connect via stdio
const server = await createButterbaseMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
