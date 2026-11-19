import { text, msg } from '../lib/i18n.js';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import {
  ragCreateCollection,
  ragListCollections,
  ragGetCollection,
  ragDeleteCollection,
  ragIngest,
  ragListDocuments,
  ragDeleteDocument,
  ragQuery,
  generateUploadUrl,
} from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const current = await getCurrentAppId();
  if (!current) {
    console.log(chalk.red(text('No app specified and no current app set')));
    console.log(chalk.gray(text('Use: butterbase apps use <app-id>')));
    process.exit(1);
  }
  return current;
}

// ─── Collections ────────────────────────────────────────────────────────────

export async function ragCollectionsListCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(text('Fetching RAG collections...')).start();
  try {
    const result: any = await ragListCollections(appId);
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const collections = result.collections ?? result ?? [];
    if (!Array.isArray(collections) || collections.length === 0) {
      console.log(chalk.gray(text('No RAG collections found.')));
      return;
    }
    console.log('');
    for (const c of collections) {
      console.log(`  ${chalk.cyan(c.name)}  ${chalk.gray(c.description ?? '')}  ${chalk.gray(msg`${c.document_count ?? 0} docs`)}`);
    }
    console.log('');
  } catch (err) {
    spinner.fail(text('Failed to fetch collections'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function ragCollectionsCreateCommand(
  name: string,
  options: {
    app?: string;
    json?: boolean;
    description?: string;
    accessMode?: string;
    chunkSize?: string;
    chunkOverlap?: string;
  }
) {
  const appId = await requireAppId(options.app);
  const spinner = ora(msg`Creating collection ${name}...`).start();
  try {
    const body: Record<string, unknown> = { name };
    if (options.description) body.description = options.description;
    if (options.accessMode) body.accessMode = options.accessMode;
    if (options.chunkSize) body.chunkSize = parseInt(options.chunkSize, 10);
    if (options.chunkOverlap) body.chunkOverlap = parseInt(options.chunkOverlap, 10);
    const result: any = await ragCreateCollection(appId, body);
    spinner.succeed(msg`Collection ${chalk.cyan(name)} created`);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(msg`  Name: ${chalk.cyan(result.name ?? name)}`);
    console.log('');
  } catch (err) {
    spinner.fail(text('Failed to create collection'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function ragCollectionsGetCommand(name: string, options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(msg`Fetching collection ${name}...`).start();
  try {
    const result: any = await ragGetCollection(appId, name);
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(msg`  Name:        ${chalk.cyan(result.name)}`);
    console.log(msg`  Description: ${chalk.gray(result.description ?? '—')}`);
    console.log(msg`  Access mode: ${result.access_mode ?? result.accessMode ?? '—'}`);
    console.log(msg`  Documents:   ${result.document_count ?? 0}`);
    console.log('');
  } catch (err) {
    spinner.fail(text('Failed to get collection'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function ragCollectionsDeleteCommand(name: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(msg`Deleting collection ${name}...`).start();
  try {
    await ragDeleteCollection(appId, name);
    spinner.succeed(msg`Deleted collection ${chalk.cyan(name)}`);
  } catch (err) {
    spinner.fail(text('Failed to delete collection'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

export async function ragIngestCommand(
  fileOrText: string,
  options: {
    app?: string;
    json?: boolean;
    collection: string;
    text?: boolean;
    filename?: string;
    metadata?: string;
  }
) {
  const appId = await requireAppId(options.app);

  if (!options.collection) {
    console.error(chalk.red(text('--collection is required')));
    process.exit(1);
  }

  const spinner = ora(text('Ingesting...')).start();
  try {
    let body: Record<string, unknown> = {};
    if (options.metadata) {
      try { body.metadata = JSON.parse(options.metadata); } catch { /* ignore */ }
    }

    if (options.text) {
      body.text = fileOrText;
      if (options.filename) body.filename = options.filename;
    } else {
      // Upload file to storage first
      const filePath = path.resolve(fileOrText);
      if (!await fs.pathExists(filePath)) {
        spinner.fail(msg`File not found: ${filePath}`);
        process.exit(1);
      }
      const stats = await fs.stat(filePath);
      const filename = options.filename ?? path.basename(filePath);

      let contentType = 'application/octet-stream';
      if (filename.endsWith('.pdf')) contentType = 'application/pdf';
      else if (filename.endsWith('.txt')) contentType = 'text/plain';
      else if (filename.endsWith('.md')) contentType = 'text/markdown';
      else if (filename.endsWith('.json')) contentType = 'application/json';

      spinner.text = text('Uploading file to storage...');
      const uploadData: any = await generateUploadUrl(appId, filename, contentType, stats.size, false);
      const fileBuffer = await fs.readFile(filePath);
      const uploadRes = await fetch(uploadData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: fileBuffer,
      });
      if (!uploadRes.ok) {
        throw new Error(msg`Storage upload failed (${uploadRes.status})`);
      }
      body.storage_object_id = uploadData.objectId;
      body.filename = filename;
      spinner.text = text('Ingesting document...');
    }

    const result: any = await ragIngest(appId, options.collection, body);
    spinner.succeed(text('Ingested'));
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(msg`  Document ID: ${chalk.cyan(result.id ?? result.document_id ?? '—')}`);
    console.log('');
  } catch (err) {
    spinner.fail(text('Ingest failed'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

// ─── Documents ───────────────────────────────────────────────────────────────

export async function ragDocsListCommand(collection: string, options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(msg`Fetching documents in ${collection}...`).start();
  try {
    const result: any = await ragListDocuments(appId, collection);
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const docs = result.documents ?? result ?? [];
    if (!Array.isArray(docs) || docs.length === 0) {
      console.log(chalk.gray(text('No documents found.')));
      return;
    }
    console.log('');
    for (const d of docs) {
      console.log(`  ${chalk.cyan(d.id)}  ${chalk.gray(d.filename ?? d.name ?? '')}  ${chalk.gray(d.status ?? '')}`);
    }
    console.log('');
  } catch (err) {
    spinner.fail(text('Failed to fetch documents'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function ragDocsDeleteCommand(collection: string, docId: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(msg`Deleting document ${docId}...`).start();
  try {
    await ragDeleteDocument(appId, collection, docId);
    spinner.succeed(msg`Deleted document ${chalk.cyan(docId)}`);
  } catch (err) {
    spinner.fail(text('Failed to delete document'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

// ─── Query ────────────────────────────────────────────────────────────────────

export async function ragQueryCommand(
  collection: string,
  options: {
    app?: string;
    json?: boolean;
    query: string;
    topK?: string;
    threshold?: string;
    synthesize?: boolean;
    model?: string;
  }
) {
  const appId = await requireAppId(options.app);

  if (!options.query) {
    console.error(chalk.red(text('-q/--query is required')));
    process.exit(1);
  }

  const spinner = ora(text('Querying...')).start();
  try {
    const body: Record<string, unknown> = { query: options.query };
    if (options.topK) body.topK = parseInt(options.topK, 10);
    if (options.threshold) body.threshold = parseFloat(options.threshold);
    if (options.synthesize !== undefined) body.synthesize = options.synthesize;
    if (options.model) body.model = options.model;

    const result: any = await ragQuery(appId, collection, body);
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    if (result.answer ?? result.synthesis) {
      console.log(chalk.bold(text('Answer:')));
      console.log((result.answer ?? result.synthesis) + '\n');
    }
    const hits = result.results ?? result.hits ?? result.documents ?? [];
    if (Array.isArray(hits) && hits.length > 0) {
      console.log(chalk.bold(text('Sources:')));
      for (const h of hits) {
        const score = h.score !== undefined ? chalk.gray(msg` (score: ${h.score.toFixed(3)})`) : '';
        console.log(`  ${chalk.cyan(h.id ?? h.document_id)}${score}`);
        if (h.content ?? h.text) {
          const snippet = (h.content ?? h.text ?? '').slice(0, 200);
          console.log(chalk.gray(`    ${snippet}${snippet.length >= 200 ? '…' : ''}`));
        }
      }
    }
    console.log('');
  } catch (err) {
    spinner.fail(text('Query failed'));
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}
