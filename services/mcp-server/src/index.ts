#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createButterbaseMcpServer } from './create-server.js';
import { loadRegionConfig } from '@butterbase/shared';

const regionConfig = loadRegionConfig(process.env);
console.log(`[mcp-server] Starting in region ${regionConfig.instanceRegion} (allowed: ${regionConfig.regions.join(',')})`);

// Connect via stdio
const server = createButterbaseMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
