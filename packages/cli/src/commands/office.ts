import { Command, Option } from 'commander';
import { readFile } from 'node:fs/promises';
import { officeActionSchema, officeMemorySchemas, type OfficeAction } from '@butterbase/shared';
import { officeRecordAgentMemorySchema, officeAmendAgentMemorySchema, officeArchiveAgentMemorySchema } from '@butterbase/shared';
import { OfficeClientError, OfficeStreamError, type OfficeClient, type OfficeResponse, type ConfirmationReceipt,
  type OfficePublicEvent, type OfficeError, type DecisionRef, type OfficeRecordDecisionInput, type OfficeRecordCommitmentInput,
  type OfficeRecordLearningInput, type OfficeRecordPrincipleInput, type OfficeRecordAgentMemoryInput,
  type OfficeAmendAgentMemoryInput, type OfficeArchiveAgentMemoryInput } from '@butterbase/sdk';
import { createOfficeCliClient, openOfficeConfirmation } from '../lib/office-client.js';

interface Options {
  org: string; json?: boolean; source?: 'office' | 'substrate'; status?: 'pending' | 'resolved' | 'all';
  limit?: string; cursor?: string; confirmation?: string; idempotencyKey?: string; title?: string;
  conversation?: string; turn?: string; afterSequence?: string; waitMs?: string; stream?: boolean;
  wait?: boolean; waitTimeout?: string; open?: boolean; file?: string; reason?: string; kind?: 'decision' | 'commitment' | 'learning';
}
class UsageError extends Error {}
const int = (value: string | undefined, name: string, max: number, min = 0): number | undefined => {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) throw new UsageError(`${name} must be an integer from ${min} to ${max}.`);
  return number;
};
function normalizeError(error: unknown): OfficeClientError {
  if (error instanceof OfficeClientError) return error;
  return new OfficeClientError({ code: error instanceof UsageError ? 'invalid_request' : 'service_unavailable',
    message: error instanceof UsageError ? error.message : 'Office command could not complete.' });
}
function jsonError(error: OfficeClientError | null) {
  if (!error) return null;
  return { ...error.detail, ...(error.status ? { status: error.status } : {}),
    ...(error.idempotencyKey ? { idempotency_key: error.idempotencyKey } : {}),
    ...(error instanceof OfficeStreamError ? { conversation_id: error.conversationId, turn_id: error.turnId, after_sequence: error.lastSequence } : {}) };
}
function guidance(error: OfficeClientError) {
  if (['unauthenticated', 'credential_revoked'].includes(error.code)) return 'Run `butterbase login` or set BUTTERBASE_API_KEY to a valid platform credential.';
  if (error.code === 'managed_credential_forbidden') return 'Use your own platform credential; managed Office keys cannot authorize these commands.';
  if (error.code === 'owner_required') return 'The current organization owner must submit this command.';
  if (error.code === 'conversation_not_client_owned') return 'Create a conversation with `butterbase office conversations create`, then continue through an Office client.';
  return error.message;
}
function emit(result: OfficeResponse<unknown>, options: Options) {
  const state = (result.data as { state?: string } | null)?.state;
  process.exitCode = result.error ? result.error.code === 'invalid_request' ? 2 : 1
    : state && ['rejected', 'expired', 'failed', 'outcome_unknown', 'blocked', 'interrupted'].includes(state) ? 1 : 0;
  if (options.json) console.log(JSON.stringify({ data: result.data, error: jsonError(result.error) }));
  else if (result.data !== null) console.log(JSON.stringify(result.data, null, 2));
  if (result.error) {
    console.error(guidance(result.error));
    if (result.error.idempotencyKey) console.error(`Retry identity: --idempotency-key ${result.error.idempotencyKey}`);
  }
}
const payloadSchemas = { ...officeMemorySchemas, record_agent_memory: officeRecordAgentMemorySchema,
  amend_agent_memory: officeAmendAgentMemorySchema, archive_agent_memory: officeArchiveAgentMemorySchema };
async function payloadFile(action: keyof typeof payloadSchemas, file?: string): Promise<unknown> {
  if (!file) throw new UsageError('--file <json> is required.');
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { throw new UsageError('Unable to read --file. Supply a readable UTF-8 JSON file.'); }
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new UsageError('Invalid JSON in --file.'); }
  const parsed = payloadSchemas[action].safeParse(input);
  if (!parsed.success) throw new UsageError(`Invalid ${action} payload: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}
async function streamAsk(client: OfficeClient, message: string, options: Options, signal: AbortSignal): Promise<OfficeResponse<unknown>> {
  const events: OfficePublicEvent[] = []; let bytes = 0;
  let conversationId = options.conversation, turnId = options.turn, sequence = int(options.afterSequence, '--after-sequence', Number.MAX_SAFE_INTEGER) ?? 0;
  let state = 'running', failure: OfficeError | undefined, decision: DecisionRef | undefined;
  let printed = '', replacement: string | undefined;
  const writeText = (text: string) => { process.stdout.write(text); printed += text; };
  const flushReplacement = () => {
    if (replacement !== undefined && !printed.endsWith(replacement)) {
      if (replacement.startsWith(printed)) writeText(replacement.slice(printed.length));
      else writeText(`${printed ? '\n' : ''}${replacement}`);
    }
    replacement = undefined;
  };
  const summary = () => ({ state, ...(options.json ? { events } : {}), conversation_id: conversationId, turn_id: turnId, last_sequence: sequence,
    ...(decision ? { decision } : {}) });
  try {
    for await (const event of client.askStream(message, { conversationId, turnId, afterSequence: sequence,
      idempotencyKey: options.idempotencyKey, signal })) {
      sequence = event.sequence;
      if (event.type === 'started' || event.type === 'completed') { conversationId = event.conversation_id; turnId = event.turn_id; }
      if (event.type === 'approval_required') { state = 'awaiting_approval'; decision = event.decision; }
      else if (event.type === 'decision_resolved') state = 'completed';
      else if (['completed', 'failed', 'blocked', 'interrupted'].includes(event.type)) state = event.type;
      if (event.type === 'failed' || event.type === 'blocked' || event.type === 'interrupted') failure = event.error;
      if (options.json) {
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (events.length >= 10000 || bytes > 8 * 1024 * 1024) throw new OfficeClientError({ code: 'event_limit_exceeded', message: 'CLI JSON event output reached its limit. Inspect this exact turn.' });
        events.push(event);
      } else if (event.type === 'message') {
        // A snapshot replaces accumulated output and may be followed by chunks.
        // Defer it until complete so already streamed final text is not echoed.
        replacement = event.text;
      } else if (event.type === 'text_delta') {
        if (replacement !== undefined) replacement += event.text;
        else writeText(event.text);
      }
    }
    if (!options.json) { flushReplacement(); process.stdout.write('\n'); }
    return { data: summary(), error: failure ? new OfficeClientError(failure) : null };
  } catch (error) {
    if (!options.json) flushReplacement();
    if (error instanceof OfficeStreamError) { conversationId = error.conversationId; turnId = error.turnId; sequence = error.lastSequence; }
    return { data: summary(), error: normalizeError(error) };
  }
}
export async function runOfficeCommand(action: OfficeAction, args: string[], options: Options): Promise<void> {
  const observer = new AbortController(); const interrupt = () => observer.abort();
  process.once('SIGINT', interrupt);
  try {
    if (!officeActionSchema.safeParse({ action: 'status', org_id: options.org }).success) throw new UsageError('--org must be an organization UUID.');
    const limit = int(options.limit, '--limit', 100, 1);
    const afterSequence = int(options.afterSequence, '--after-sequence', Number.MAX_SAFE_INTEGER);
    const waitMs = int(options.waitMs, '--wait-ms', 25000);
    const timeoutMs = int(options.waitTimeout, '--wait-timeout', 2147483647);
    if (action === 'ask' && !options.stream && (options.turn || options.afterSequence !== undefined)) throw new UsageError('--turn and --after-sequence require --stream.');
    if (action === 'ask' && !args[0] && !(options.stream && options.turn && options.conversation)) throw new UsageError('Supply a message, or use --stream --conversation <id> --turn <id> to observe an existing turn.');
    const payload = action in payloadSchemas ? await payloadFile(action as keyof typeof payloadSchemas, options.file) : undefined;
    const client = await createOfficeCliClient(options.org);
    const request = { signal: observer.signal }, write = { ...request, idempotencyKey: options.idempotencyKey };
    const page = { ...request, cursor: options.cursor, limit };
    const ref = { source: options.source ?? 'office', id: args[0] ?? '' };
    let result: OfficeResponse<unknown>;
    switch (action) {
      case 'status': result = options.confirmation ? await client.getConfirmation(options.confirmation, request) : await client.getStatus(request); break;
      case 'enable': result = await client.enable(write); break;
      case 'pause': result = await client.pause(write); break;
      case 'resume': result = await client.resume(write); break;
      case 'list_decisions': result = await client.decisions.list({ ...page, status: options.status }); break;
      case 'get_decision': result = await client.decisions.get(ref, request); break;
      case 'get_decision_context': result = await client.decisions.getContext(ref, { ...request, limit }); break;
      case 'approve': result = await client.decisions.approve(ref, write); break;
      case 'deny': result = await client.decisions.deny(ref, { ...request, reason: options.reason ?? '' }); break;
      case 'create_conversation': result = await client.conversations.create({ ...write, title: options.title }); break;
      case 'list_conversations': result = await client.conversations.list(page); break;
      case 'get_conversation': result = await client.conversations.get(args[0], { ...request, turnId: options.turn, afterSequence, limit }); break;
      case 'ask': result = options.stream ? await streamAsk(client, args[0] ?? '', options, observer.signal)
        : await client.ask(args[0], { ...write, conversationId: options.conversation, waitMs }); break;
      case 'list_memory': result = await client.memory.list({ ...page, kind: options.kind }); break;
      case 'list_agent_memories': result = await client.agentMemories.list(page); break;
      case 'search_agent_memories': result = await client.agentMemories.search(args[0], page); break;
      case 'get_agent_memory': result = await client.agentMemories.get(args[0], request); break;
      case 'record_agent_memory': result = await client.agentMemories.record(payload as OfficeRecordAgentMemoryInput, write); break;
      case 'amend_agent_memory': result = await client.agentMemories.amend(payload as OfficeAmendAgentMemoryInput, write); break;
      case 'archive_agent_memory': result = await client.agentMemories.archive(payload as OfficeArchiveAgentMemoryInput, write); break;
      case 'search_memory': result = await client.memory.search(args[0], { ...request, limit }); break;
      case 'get_source_artifact': result = await client.memory.getSourceArtifact(args[0], request); break;
      case 'record_decision': result = await client.memory.recordDecision(payload as OfficeRecordDecisionInput, write); break;
      case 'record_commitment': result = await client.memory.recordCommitment(payload as OfficeRecordCommitmentInput, write); break;
      case 'record_learning': result = await client.memory.recordLearning(payload as OfficeRecordLearningInput, write); break;
      case 'list_principles': result = await client.principles.list(page); break;
      case 'get_principle': result = await client.principles.get(args[0], request); break;
      case 'record_principle': result = await client.principles.record(payload as OfficeRecordPrincipleInput, write); break;
    }
    const receipt = result.data as ConfirmationReceipt | null;
    if (!result.error && receipt?.state === 'awaiting_confirmation') {
      if (options.wait) console.error(`Confirm this saved request in your browser: ${receipt.confirmation_url}`);
      if (options.open) {
        try { await openOfficeConfirmation(receipt.confirmation_url); }
        catch { console.error(`Could not open a browser. Open this URL yourself: ${receipt.confirmation_url}`); }
      }
    }
    if (!result.error && options.wait && receipt && ['awaiting_confirmation', 'executing'].includes(receipt.state)) {
      const waited = await client.waitForConfirmation(receipt.confirmation_id, { ...request, timeoutMs });
      result = { ...waited, data: waited.data ?? receipt };
    }
    emit(result, options);
  } catch (error) { emit({ data: null, error: normalizeError(error) }, options); }
  finally { process.removeListener('SIGINT', interrupt); }
}

export function registerOfficeCommands(program: Command): Command {
  const office = program.command('office').description('Ask Office and manage organization decisions and business memory')
    .requiredOption('--org <uuid>', 'Explicit organization UUID; no app selection')
    .option('--json', 'Output one JSON result; diagnostics go to stderr')
    .configureHelp({ showGlobalOptions: true });
  office.addHelpText('after', '\nExit codes: 0 accepted/read (including pending confirmation); 1 request, terminal or observation failure; 2 usage/input error.\nClosing a confirmation page or stopping observation does not cancel server work.');
  office.exitOverride(error => {
    if (error.exitCode !== 0) {
      error.exitCode = 2;
      if (office.opts().json) console.log(JSON.stringify({ data: null, error: { code: 'invalid_request', message: error.message } }));
    }
    throw error;
  });
  function leaf(parent: Command, syntax: string, action: OfficeAction, description: string): Command {
    const command = parent.command(syntax).description(description);
    command.action(async (...args: unknown[]) => {
      const parsed = args.at(-1) as Command;
      await runOfficeCommand(action, args.slice(0, -2) as string[], parsed.optsWithGlobals() as Options);
    });
    return command;
  }
  const page = (command: Command) => command.option('--limit <n>', 'Maximum records (1–100)').option('--cursor <cursor>', 'Continue from next_cursor');
  const write = (command: Command) => command.option('--idempotency-key <key>', 'Reuse the same key only when retrying the same intended write');
  const protect = (command: Command) => write(command).option('--wait', 'Observe the receipt until resolved').option('--wait-timeout <ms>', 'Observation timeout in milliseconds', '120000').option('--open', 'Explicitly open the owner confirmation URL');
  const source = (command: Command) => command.addOption(new Option('--source <source>', 'Decision source').choices(['office', 'substrate']).default('office'));
  leaf(office, 'status', 'status', 'Read Office or one confirmation receipt').option('--confirmation <id>', 'Inspect an exact confirmation receipt');
  protect(leaf(office, 'enable', 'enable', 'Request owner confirmation to enable Office'));
  protect(leaf(office, 'pause', 'pause', 'Request owner confirmation to pause Office'));
  protect(leaf(office, 'resume', 'resume', 'Request owner confirmation to resume Office'));
  write(leaf(office, 'ask [message]', 'ask', 'Submit one question, or observe an exact existing turn'))
    .option('--conversation <id>', 'Office conversation ID').option('--stream', 'Stream public events; JSON mode collects one final result')
    .option('--turn <id>', 'Observe an already admitted turn; requires --stream and --conversation')
    .option('--after-sequence <n>', 'Replay events after this sequence').option('--wait-ms <ms>', 'Bounded Ask wait (0–25000)');
  const decisions = office.command('decisions').description('Read, approve or deny saved decisions');
  page(leaf(decisions, 'list', 'list_decisions', 'List source-aware decisions')).addOption(new Option('--status <status>').choices(['pending', 'resolved', 'all']).default('pending'));
  source(leaf(decisions, 'get <id>', 'get_decision', 'Read a saved decision'));
  source(leaf(decisions, 'context <id>', 'get_decision_context', 'Read decision context')).option('--limit <n>', 'Maximum context records (1–100)');
  protect(source(leaf(decisions, 'approve <id>', 'approve', 'Request browser confirmation of this saved decision')));
  source(leaf(decisions, 'deny <id>', 'deny', 'Deny a saved decision')).requiredOption('--reason <text>', 'Reason for denial');
  const conversations = office.command('conversations').description('Manage Office conversations');
  write(leaf(conversations, 'create', 'create_conversation', 'Create an Office conversation')).option('--title <text>', 'Conversation title');
  page(leaf(conversations, 'list', 'list_conversations', 'List your Office conversations'));
  leaf(conversations, 'get <id>', 'get_conversation', 'Read a conversation or exact turn').option('--turn <id>', 'Exact turn ID')
    .option('--after-sequence <n>', 'Include remaining public turn events').option('--limit <n>', 'Maximum records (1–100)');
  const memory = office.command('memory').description('Read or record business memory through native Substrate APIs');
  const agentMemories = office.command('agent-memories').description('Read or update curated shared Office context');
  page(leaf(agentMemories, 'list', 'list_agent_memories', 'List compact memory summaries'));
  page(leaf(agentMemories, 'search <query>', 'search_agent_memories', 'Search curated memories'));
  leaf(agentMemories, 'get <id>', 'get_agent_memory', 'Read one full memory');
  for (const [syntax, action] of [['record', 'record_agent_memory'], ['amend', 'amend_agent_memory'], ['archive', 'archive_agent_memory']] as const) {
    write(leaf(agentMemories, syntax, action, 'Write curated memory through Substrate policy'))
      .requiredOption('--file <json>', 'JSON payload; amendment/archive requires memory_id and expected_revision');
  }
  page(leaf(memory, 'list', 'list_memory', 'List business memory')).addOption(new Option('--kind <kind>').choices(['decision', 'commitment', 'learning']));
  leaf(memory, 'search <query>', 'search_memory', 'Search business memory').option('--limit <n>', 'Maximum results (1–100; search has no cursor)');
  leaf(memory.command('source').description('Read source artifacts'), 'get <id>', 'get_source_artifact', 'Read a source artifact');
  for (const [syntax, action] of [['record-decision', 'record_decision'], ['record-commitment', 'record_commitment'], ['record-learning', 'record_learning']] as const) {
    write(leaf(memory, syntax, action, 'Record a native business memory payload')).requiredOption('--file <json>', 'UTF-8 JSON matching the native record schema');
  }
  const principles = office.command('principles').description('Read or propose business principles');
  page(leaf(principles, 'list', 'list_principles', 'List principles'));
  leaf(principles, 'get <id>', 'get_principle', 'Read a principle');
  write(leaf(principles, 'record', 'record_principle', 'Propose a principle through native policy')).requiredOption('--file <json>', 'UTF-8 JSON matching the native principle schema');
  return office;
}
