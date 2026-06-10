// services/control-api/src/services/cloudflare-containers.ts
//
// Deploys per-container Workers into the bb-containers WfP dispatch
// namespace. Metadata shape per docs/containers-cf-api-notes.md §2 —
// currently INFERRED from wrangler source, NOT yet proven by a live 200
// (spike blocked on credentials). Do not change field names without
// updating the notes file; verify against the spike re-run before GA.
import { config } from '../config.js';
import { cfFetch } from './cloudflare-client.js';
import { CTR_CLASS_NAME } from './ctr-front-door.js';

const NS = config.cloudflare.containersDispatchNamespace;

export interface ContainerDeployInput {
  scriptName: string;             // `${appId}_ctr_${name}`
  workerSource: string;           // from buildFrontDoorWorker()
  imageRef: string;               // '{registryHost}/{account}/{app_id}/{name}@sha256:...'
  instanceType: 'dev' | 'basic' | 'standard';
  maxInstances: number;
  envVars: Record<string, string>;
  // First-ever deploy must include the DO class migration; CF rejects a
  // repeated new_sqlite_classes for an existing script.
  isFirstDeploy: boolean;
}

export async function deployContainerWorker(input: ContainerDeployInput): Promise<void> {
  const { scriptName, workerSource, imageRef, instanceType, maxInstances, envVars, isFirstDeploy } = input;

  const metadata: Record<string, unknown> = {
    main_module: 'worker.mjs',
    compatibility_date: '2025-01-24',
    bindings: [
      { type: 'durable_object_namespace', name: 'CTR', class_name: CTR_CLASS_NAME },
      ...Object.entries(envVars).map(([name, text]) => ({ type: 'plain_text', name, text })),
    ],
    containers: [
      { class_name: CTR_CLASS_NAME, image: imageRef, instance_type: instanceType, max_instances: maxInstances },
    ],
    ...(isFirstDeploy
      ? { migrations: { new_tag: 'v1', new_sqlite_classes: [CTR_CLASS_NAME] } }
      : {}),
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.mjs', new Blob([workerSource], { type: 'application/javascript+module' }), 'worker.mjs');

  await cfFetch(`/workers/dispatch/namespaces/${NS}/scripts/${scriptName}`, {
    method: 'PUT',
    body: form,
  });
}

export async function deleteContainerWorker(scriptName: string): Promise<void> {
  await cfFetch(`/workers/dispatch/namespaces/${NS}/scripts/${scriptName}`, {
    method: 'DELETE',
  });
}
