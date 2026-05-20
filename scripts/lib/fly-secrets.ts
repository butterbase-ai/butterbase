import { execFile } from 'node:child_process';

export interface SetSecretParams {
  app: string;
  key: string;
  value: string;
  /** If true, pass --stage so the change is buffered; deploy / restart applies it. */
  stage: boolean;
}

export function setFlySecret(params: SetSecretParams): Promise<void> {
  const args = ['secrets', 'set', '--app', params.app];
  if (params.stage) args.push('--stage');
  args.push(`${params.key}=${params.value}`);

  return new Promise((resolve, reject) => {
    execFile('flyctl', args, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`flyctl secrets set failed for ${params.app}: ${stderr || err.message}`));
        return;
      }
      resolve();
    });
  });
}

export interface RestartParams {
  app: string;
}

export function restartFlyApp(params: RestartParams): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('flyctl', ['apps', 'restart', params.app], (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`flyctl apps restart failed for ${params.app}: ${stderr || err.message}`));
        return;
      }
      resolve();
    });
  });
}
