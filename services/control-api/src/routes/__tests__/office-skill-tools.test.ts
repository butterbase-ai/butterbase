import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __setOfficeAskExecutorsLoaderForTest, resolveOfficeAskExecutors,
} from '../dashboard-agent.js';

afterEach(() => { __setOfficeAskExecutorsLoaderForTest(null); });

const officeConversation = { origin: 'office', organizationId: 'org-1' };
const dashboardConversation = { origin: 'dashboard', organizationId: null };

describe('resolveOfficeAskExecutors', () => {
  it('takes the overlay-supplied executors for an Office conversation', async () => {
    const skillCreator = vi.fn();
    const integrationReader = vi.fn();
    const loader = vi.fn(async () => ({ skillCreator, integrationReader }));
    __setOfficeAskExecutorsLoaderForTest(loader);

    const executors = await resolveOfficeAskExecutors({
      controlPool: {}, conversation: officeConversation, userId: 'user-1',
    });

    expect(loader).toHaveBeenCalledWith({
      controlPool: {}, conversation: officeConversation, userId: 'user-1',
    });
    expect(executors).toEqual({ skillCreator, integrationReader });
  });

  it('gives a dashboard conversation neither, and never consults the overlay', async () => {
    const loader = vi.fn(async () => ({ skillCreator: vi.fn() }));
    __setOfficeAskExecutorsLoaderForTest(loader);

    const executors = await resolveOfficeAskExecutors({
      controlPool: {}, conversation: dashboardConversation, userId: 'user-1',
    });

    expect(executors).toEqual({});
    expect(loader).not.toHaveBeenCalled();
  });

  it('fails closed when the overlay throws', async () => {
    __setOfficeAskExecutorsLoaderForTest(async () => { throw new Error('overlay down'); });

    const executors = await resolveOfficeAskExecutors({
      controlPool: {}, conversation: officeConversation, userId: 'user-1',
    });
    expect(executors).toEqual({});
  });

  it('fails closed in OSS mode, where the overlay module does not exist', async () => {
    const executors = await resolveOfficeAskExecutors({
      controlPool: {}, conversation: officeConversation, userId: 'user-1',
    });
    expect(executors).toEqual({});
  });
});
