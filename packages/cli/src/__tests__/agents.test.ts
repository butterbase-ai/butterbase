import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the api-client module before importing the command
vi.mock('../lib/api-client.js', () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));

vi.mock('../lib/config.js', () => ({
  getCurrentAppId: vi.fn().mockResolvedValue('test-app'),
}));

import * as apiClient from '../lib/api-client.js';
import {
  agentsListCommand,
  agentsGetCommand,
  agentsCreateCommand,
  agentsUpdateCommand,
  agentsDeleteCommand,
} from '../commands/agents.js';

describe('agents list', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints agents returned by the API', async () => {
    vi.mocked(apiClient.listAgents).mockResolvedValue({
      agents: [
        {
          name: 'my-agent',
          display_name: 'My Agent',
          description: 'Does something useful',
          visibility: 'public',
          default_model: 'gpt-4o',
        },
      ],
    } as any);

    await agentsListCommand('test-app');

    expect(apiClient.listAgents).toHaveBeenCalledWith('test-app');

    const allOutput = consoleLogSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(allOutput).toContain('my-agent');
    expect(allOutput).toContain('My Agent');
    expect(allOutput).toContain('Does something useful');
    expect(allOutput).toContain('public');
    expect(allOutput).toContain('gpt-4o');
  });

  it('prints a message when no agents exist', async () => {
    vi.mocked(apiClient.listAgents).mockResolvedValue({ agents: [] } as any);

    await agentsListCommand('test-app');

    const allOutput = consoleLogSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(allOutput).toContain('No agents found');
  });
});

describe('agents get', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints agent details', async () => {
    vi.mocked(apiClient.getAgent).mockResolvedValue({
      agent: {
        name: 'my-agent',
        display_name: 'My Agent',
        description: 'Does something',
        visibility: 'private',
        default_model: 'claude-3-5-sonnet',
        max_runs_per_user_per_hour: 10,
        daily_budget_usd: 5.0,
      },
    } as any);

    await agentsGetCommand('test-app', 'my-agent');

    expect(apiClient.getAgent).toHaveBeenCalledWith('test-app', 'my-agent');

    const allOutput = consoleLogSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(allOutput).toContain('my-agent');
    expect(allOutput).toContain('My Agent');
    expect(allOutput).toContain('claude-3-5-sonnet');
    expect(allOutput).toContain('10');
    expect(allOutput).toContain('5');
  });
});

describe('agents create', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let tmpFile: string;

  beforeEach(async () => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Write a temp spec file
    const { default: fs } = await import('fs-extra');
    const os = await import('os');
    const path = await import('path');
    tmpFile = path.join(os.tmpdir(), `agent-spec-test-${Date.now()}.json`);
    await fs.writeFile(
      tmpFile,
      JSON.stringify({
        name: 'new-agent',
        display_name: 'New Agent',
        description: 'A new agent',
        visibility: 'public',
        safety_acknowledged: true,
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { default: fs } = await import('fs-extra');
    await fs.remove(tmpFile).catch(() => {});
  });

  it('reads the spec file and calls createAgent', async () => {
    vi.mocked(apiClient.createAgent).mockResolvedValue({ agent: { name: 'new-agent' } } as any);

    await agentsCreateCommand('test-app', { file: tmpFile });

    expect(apiClient.createAgent).toHaveBeenCalledWith(
      'test-app',
      expect.objectContaining({ name: 'new-agent', visibility: 'public' }),
    );

    const allOutput = consoleLogSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(allOutput).toContain('Agent created successfully');
  });
});

describe('agents update', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let tmpFile: string;

  beforeEach(async () => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { default: fs } = await import('fs-extra');
    const os = await import('os');
    const path = await import('path');
    tmpFile = path.join(os.tmpdir(), `agent-update-test-${Date.now()}.json`);
    await fs.writeFile(
      tmpFile,
      JSON.stringify({ name: 'existing-agent', description: 'Updated description' }),
      'utf-8',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { default: fs } = await import('fs-extra');
    await fs.remove(tmpFile).catch(() => {});
  });

  it('strips name from body and calls updateAgent', async () => {
    vi.mocked(apiClient.updateAgent).mockResolvedValue({} as any);

    await agentsUpdateCommand('test-app', 'existing-agent', { file: tmpFile });

    expect(apiClient.updateAgent).toHaveBeenCalledWith(
      'test-app',
      'existing-agent',
      expect.not.objectContaining({ name: expect.anything() }),
    );
    expect(apiClient.updateAgent).toHaveBeenCalledWith(
      'test-app',
      'existing-agent',
      expect.objectContaining({ description: 'Updated description' }),
    );

    const allOutput = consoleLogSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(allOutput).toContain('Agent updated successfully');
  });
});

describe('agents delete', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes without prompt when --yes is passed', async () => {
    vi.mocked(apiClient.deleteAgent).mockResolvedValue(undefined as any);

    await agentsDeleteCommand('test-app', 'my-agent', { yes: true });

    expect(apiClient.deleteAgent).toHaveBeenCalledWith('test-app', 'my-agent');

    const allOutput = consoleLogSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(allOutput).toContain('Agent deleted successfully');
  });
});
