import { describe, it, expect, vi } from 'vitest';

vi.mock('../store.js', () => ({
  getRecentToolArgs: vi.fn(),
}));

import * as storeModule from '../store.js';
import {
  formatCompactSchema,
  buildSchemaPromptBlock,
  fetchAppSchemas,
  fetchAppSchemasCached,
  getRecentAppIds,
} from '../schema-context.js';

const mockGetRecentToolArgs = storeModule.getRecentToolArgs as ReturnType<typeof vi.fn>;

describe('formatCompactSchema', () => {
  it('renders a single table with pk, NOT NULL, and plain columns', () => {
    const schema = {
      tables: {
        todos: {
          columns: {
            id: { type: 'uuid', primaryKey: true },
            title: { type: 'text', nullable: false },
            done: { type: 'boolean' },
            user_id: { type: 'uuid', nullable: false },
          },
        },
      },
    };

    expect(formatCompactSchema(schema)).toBe(
      'todos(id uuid pk, title text NOT NULL, done boolean, user_id uuid NOT NULL)',
    );
  });

  it('renders multiple tables on separate lines', () => {
    const schema = {
      tables: {
        posts: { columns: { id: { type: 'uuid', primaryKey: true } } },
        comments: { columns: { id: { type: 'uuid', primaryKey: true } } },
      },
    };

    expect(formatCompactSchema(schema)).toBe('posts(id uuid pk)\ncomments(id uuid pk)');
  });

  it('returns empty string for a schema with no tables', () => {
    expect(formatCompactSchema({ tables: {} })).toBe('');
    expect(formatCompactSchema({})).toBe('');
  });

  it('treats nullable columns without NOT NULL/pk markers as plain', () => {
    const schema = {
      tables: {
        widgets: { columns: { note: { type: 'text', nullable: true } } },
      },
    };
    expect(formatCompactSchema(schema)).toBe('widgets(note text)');
  });
});

describe('buildSchemaPromptBlock', () => {
  it('returns empty string for an empty map', () => {
    expect(buildSchemaPromptBlock({})).toBe('');
  });

  it('formats the header block with one line per app', () => {
    const block = buildSchemaPromptBlock({
      app_1: 'todos(id uuid pk, title text NOT NULL)',
      app_2: 'posts(id uuid pk)',
    });

    expect(block).toBe(
      '# Current app schemas\n\napp_1: todos(id uuid pk, title text NOT NULL)\napp_2: posts(id uuid pk)\n\n',
    );
  });
});

describe('fetchAppSchemas', () => {
  it('calls manage_schema.get for each app_id and compacts the result', async () => {
    const mcp = {
      call: vi.fn().mockImplementation(async (_name: string, args: any) => {
        if (args.app_id === 'app_1') {
          return { schema: { tables: { todos: { columns: { id: { type: 'uuid', primaryKey: true } } } } } };
        }
        return { schema: { tables: { posts: { columns: { id: { type: 'uuid', primaryKey: true } } } } } };
      }),
    };

    const result = await fetchAppSchemas(['app_1', 'app_2'], 'jwt-1', mcp);

    expect(mcp.call).toHaveBeenCalledWith('manage_schema', { action: 'get', app_id: 'app_1' }, 'jwt-1');
    expect(mcp.call).toHaveBeenCalledWith('manage_schema', { action: 'get', app_id: 'app_2' }, 'jwt-1');
    expect(result).toEqual({
      app_1: 'todos(id uuid pk)',
      app_2: 'posts(id uuid pk)',
    });
  });

  it('logs and skips an app whose manage_schema.get call fails, without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mcp = {
      call: vi.fn().mockImplementation(async (_name: string, args: any) => {
        if (args.app_id === 'app_bad') throw new Error('boom');
        return { schema: { tables: { posts: { columns: { id: { type: 'uuid', primaryKey: true } } } } } };
      }),
    };

    const result = await fetchAppSchemas(['app_bad', 'app_good'], 'jwt-1', mcp);

    expect(result).toEqual({ app_good: 'posts(id uuid pk)' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('skips an app whose schema has no tables (empty compact string)', async () => {
    const mcp = { call: vi.fn().mockResolvedValue({ schema: { tables: {} } }) };
    const result = await fetchAppSchemas(['app_empty'], 'jwt-1', mcp);
    expect(result).toEqual({});
  });
});

describe('getRecentAppIds', () => {
  const stubPool = {} as any;

  it('extracts and dedupes app_id from tool_args across recent messages', async () => {
    mockGetRecentToolArgs.mockResolvedValueOnce([
      { action: 'get_config', app_id: 'app_2' },
      null,
      { action: 'write_file', app_id: 'app_1', path: 'src/App.tsx' },
      { action: 'get_config', app_id: 'app_1' },
    ]);

    const result = await getRecentAppIds(stubPool, 'conv-1');

    expect(mockGetRecentToolArgs).toHaveBeenCalledWith(stubPool, 'conv-1', 20);
    expect(result).toEqual(['app_2', 'app_1']);
  });

  it('returns an empty array when there are no tool_args', async () => {
    mockGetRecentToolArgs.mockResolvedValueOnce([null, null]);
    const result = await getRecentAppIds(stubPool, 'conv-1');
    expect(result).toEqual([]);
  });

  it('respects a custom limit', async () => {
    mockGetRecentToolArgs.mockResolvedValueOnce([]);
    await getRecentAppIds(stubPool, 'conv-1', 5);
    expect(mockGetRecentToolArgs).toHaveBeenCalledWith(stubPool, 'conv-1', 5);
  });
});

describe('fetchAppSchemasCached', () => {
  it('only fetches app_ids missing from the cache', async () => {
    const mcp = {
      call: vi.fn().mockResolvedValue({ schema: { tables: { t: { columns: { id: { type: 'uuid', primaryKey: true } } } } } }),
    };
    const cache = new Map<string, string>([['app_cached', 'existing(id uuid pk)']]);

    const result = await fetchAppSchemasCached(['app_cached', 'app_new'], 'jwt-1', mcp, cache);

    expect(mcp.call).toHaveBeenCalledTimes(1);
    expect(mcp.call).toHaveBeenCalledWith('manage_schema', { action: 'get', app_id: 'app_new' }, 'jwt-1');
    expect(result).toEqual({
      app_cached: 'existing(id uuid pk)',
      app_new: 't(id uuid pk)',
    });
    expect(cache.get('app_new')).toBe('t(id uuid pk)');
  });
});
