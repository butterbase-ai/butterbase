import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── SDK mock ─────────────────────────────────────────────────────────────────
// Use vi.hoisted so the object is initialized before vi.mock's factory runs.
// This lets the factory closure capture the real object reference.
const mockPeople = vi.hoisted(() => ({
  searchPerson: vi.fn(),
  searchCompany: vi.fn(),
  getProfile: vi.fn(),
  queueEmailLookup: vi.fn(),
  getEmailLookup: vi.fn(),
}));

vi.mock('@butterbase/sdk', () => ({
  createClient: () => ({ people: mockPeople }),
}));

vi.mock('../lib/config.js', () => ({
  getCurrentAppId: vi.fn().mockResolvedValue('test-app'),
  getMergedConfig: vi.fn().mockResolvedValue({
    endpoint: 'https://api.butterbase.ai',
    apiKey: 'bb_test_key',
  }),
}));

import {
  peopleSearchPersonCommand,
  peopleSearchCompanyCommand,
  peopleProfileCommand,
  peopleEmailLookupCommand,
  peopleEmailStatusCommand,
} from '../commands/people.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_META = {
  provider: 'primary' as const,
  creditsConsumed: 6,
  usdCost: 0.12096,
  usdCharged: 0.12096,
};

const MOCK_PERSON_RESULT = {
  linkedinProfileUrl: 'https://www.linkedin.com/in/alice-test',
  profile: {
    fullName: 'Alice Test',
    headline: 'VP of Engineering',
    city: 'San Francisco',
    country: 'US',
    experiences: [],
    education: [],
    raw: {},
  },
  lastUpdated: '2026-01-01',
};

const MOCK_COMPANY_RESULT = {
  linkedinUrl: 'https://www.linkedin.com/company/acme',
  name: 'Acme Corp',
  industry: 'Software',
  country: 'US',
  employeeCount: 500,
};

// ─── search-person ────────────────────────────────────────────────────────────

describe('people search-person', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Use clearAllMocks to reset call history without removing mock implementations.
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPeople.searchPerson.mockResolvedValue({
      data: {
        results: [MOCK_PERSON_RESULT],
        nextPage: null,
        totalResultCount: 1,
      },
      meta: MOCK_META,
    });
  });

  afterEach(() => {
    logSpy?.mockRestore();
  });

  it('calls searchPerson with query and default pageSize', async () => {
    await peopleSearchPersonCommand('VPs in tech', { app: 'test-app' });
    expect(mockPeople.searchPerson).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'VPs in tech', pageSize: 10 }),
    );
  });

  it('renders a table with Name, Headline, Location, LinkedIn URL columns', async () => {
    await peopleSearchPersonCommand('VPs in tech', { app: 'test-app' });
    const output = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(output).toContain('Alice Test');
    expect(output).toContain('VP of Engineering');
    expect(output).toContain('linkedin.com/in/alice-test');
  });

  it('passes pageSize from --limit option', async () => {
    await peopleSearchPersonCommand('VPs in tech', { app: 'test-app', limit: 25 });
    expect(mockPeople.searchPerson).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 25 }),
    );
  });

  it('--json flag emits raw JSON instead of table', async () => {
    await peopleSearchPersonCommand('VPs in tech', { app: 'test-app', json: true });
    const output = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.data.results[0].linkedinProfileUrl).toBe('https://www.linkedin.com/in/alice-test');
    expect(parsed.meta.creditsConsumed).toBe(6);
  });

  it('renders footer with credits and USD charged', async () => {
    await peopleSearchPersonCommand('VPs in tech', { app: 'test-app' });
    const output = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(output).toContain('6 credits');
    expect(output).toContain('0.12096');
  });
});

// ─── search-company ───────────────────────────────────────────────────────────

describe('people search-company', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPeople.searchCompany.mockResolvedValue({
      data: {
        results: [MOCK_COMPANY_RESULT],
        nextPage: null,
        totalResultCount: 1,
      },
      meta: MOCK_META,
    });
  });

  afterEach(() => {
    logSpy?.mockRestore();
  });

  it('calls searchCompany with query and default pageSize', async () => {
    await peopleSearchCompanyCommand('software companies', { app: 'test-app' });
    expect(mockPeople.searchCompany).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'software companies', pageSize: 10 }),
    );
  });

  it('renders columns Name, LinkedIn URL, Industry, Employees', async () => {
    await peopleSearchCompanyCommand('software companies', { app: 'test-app' });
    const output = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(output).toContain('Acme Corp');
    expect(output).toContain('linkedin.com/company/acme');
    expect(output).toContain('Software');
    expect(output).toContain('500');
  });

  it('--json emits raw JSON', async () => {
    await peopleSearchCompanyCommand('software companies', { app: 'test-app', json: true });
    const output = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.data.results[0].name).toBe('Acme Corp');
  });
});

// ─── profile ──────────────────────────────────────────────────────────────────

describe('people profile', () => {
  const PROFILE_URL = 'https://www.linkedin.com/in/alice-test';
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPeople.getProfile.mockResolvedValue({
      data: {
        fullName: 'Alice Test',
        headline: 'VP of Engineering',
        city: 'San Francisco',
        country: 'US',
        experiences: [
          { title: 'VP Engineering', company: 'Acme', startDate: { year: 2022 } },
        ],
        education: [
          { school: 'MIT', degree: 'BS', fieldOfStudy: 'CS' },
        ],
        raw: {},
      },
      meta: { ...MOCK_META, cached: false },
    });
  });

  afterEach(() => {
    logSpy?.mockRestore();
  });

  it('calls getProfile with the LinkedIn URL', async () => {
    await peopleProfileCommand(PROFILE_URL, { app: 'test-app' });
    expect(mockPeople.getProfile).toHaveBeenCalledWith(
      expect.objectContaining({ linkedinProfileUrl: PROFILE_URL }),
    );
  });

  it('--live passes liveFetch: "force"', async () => {
    await peopleProfileCommand(PROFILE_URL, { app: 'test-app', live: true });
    expect(mockPeople.getProfile).toHaveBeenCalledWith(
      expect.objectContaining({ liveFetch: 'force' }),
    );
  });

  it('does NOT pass liveFetch when --live is absent', async () => {
    await peopleProfileCommand(PROFILE_URL, { app: 'test-app' });
    expect(mockPeople.getProfile).toHaveBeenCalledWith(
      expect.not.objectContaining({ liveFetch: 'force' }),
    );
  });

  it('renders name, headline, experiences, education', async () => {
    await peopleProfileCommand(PROFILE_URL, { app: 'test-app' });
    const output = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(output).toContain('Alice Test');
    expect(output).toContain('VP of Engineering');
    expect(output).toContain('VP Engineering');
    expect(output).toContain('MIT');
  });

  it('--json bypasses pretty print', async () => {
    await peopleProfileCommand(PROFILE_URL, { app: 'test-app', json: true });
    const output = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.data.fullName).toBe('Alice Test');
  });
});

// ─── email-lookup ─────────────────────────────────────────────────────────────

describe('people email-lookup', () => {
  const PROFILE_URL = 'https://www.linkedin.com/in/alice-test';
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPeople.queueEmailLookup.mockResolvedValue({
      data: { lookupId: 'lk_abc123', status: 'pending' },
      meta: MOCK_META,
    });
  });

  afterEach(() => {
    logSpy?.mockRestore();
  });

  it('calls queueEmailLookup with the LinkedIn URL', async () => {
    await peopleEmailLookupCommand(PROFILE_URL, { app: 'test-app' });
    expect(mockPeople.queueEmailLookup).toHaveBeenCalledWith(
      { linkedinProfileUrl: PROFILE_URL },
    );
  });

  it('prints the lookupId and instructs the user to poll', async () => {
    await peopleEmailLookupCommand(PROFILE_URL, { app: 'test-app' });
    const output = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(output).toContain('lk_abc123');
    expect(output).toContain('email-status');
  });

  it('--json emits raw JSON', async () => {
    await peopleEmailLookupCommand(PROFILE_URL, { app: 'test-app', json: true });
    const output = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.data.lookupId).toBe('lk_abc123');
  });
});

// ─── email-status ─────────────────────────────────────────────────────────────

describe('people email-status', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy?.mockRestore();
  });

  it('fetches and prints status + email on resolve', async () => {
    mockPeople.getEmailLookup.mockResolvedValue({
      data: { status: 'resolved', email: 'alice@example.com', creditsConsumed: 1 },
      meta: MOCK_META,
    });
    await peopleEmailStatusCommand('lk_abc123', { app: 'test-app' });
    const output = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(output).toContain('resolved');
    expect(output).toContain('alice@example.com');
  });

  it('--watch polls until resolved — 3 status transitions', async () => {
    vi.useFakeTimers();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    let callCount = 0;
    mockPeople.getEmailLookup.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { data: { status: 'pending', email: null, creditsConsumed: null }, meta: MOCK_META };
      if (callCount === 2) return { data: { status: 'processing', email: null, creditsConsumed: null }, meta: MOCK_META };
      return { data: { status: 'resolved', email: 'alice@example.com', creditsConsumed: 1 }, meta: MOCK_META };
    });

    const watchPromise = peopleEmailStatusCommand('lk_abc123', { app: 'test-app', watch: true });

    // Advance fake timers for each poll interval
    await vi.runAllTimersAsync();

    await watchPromise;

    expect(callCount).toBe(3);
    const written = stdoutSpy.mock.calls.map((a) => String(a[0])).join('');
    expect(written).toContain('pending');
    expect(written).toContain('processing');
    expect(written).toContain('resolved');
    expect(written).toContain('alice@example.com');

    stdoutSpy.mockRestore();
    vi.useRealTimers();
  });
});
