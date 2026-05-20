import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import { generateUploadUrl, listStorageObjects, deleteStorageObject, getAppConfig, updateStorageConfig } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;

  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.log(chalk.red('✗ No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }

  return currentAppId;
}

export async function storageListCommand(options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching storage objects...').start();

  try {
    const response: any = await listStorageObjects(appId);
    spinner.stop();

    if (!response.objects || response.objects.length === 0) {
      console.log(chalk.yellow('No files found'));
      return;
    }

    console.log(chalk.blue('\nStorage objects:\n'));
    for (const obj of response.objects) {
      console.log(chalk.bold(obj.filename));
      console.log(chalk.gray(`  ID: ${obj.id}`));
      console.log(chalk.gray(`  Size: ${(obj.size_bytes / 1024).toFixed(2)} KB`));
      console.log(chalk.gray(`  Type: ${obj.content_type}`));
      console.log();
    }
  } catch (error) {
    spinner.fail('Failed to fetch storage objects');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function storageUploadCommand(file: string, options: { app?: string; public?: boolean }) {
  const appId = await requireAppId(options.app);

  if (!await fs.pathExists(file)) {
    console.log(chalk.red(`✗ File not found: ${file}`));
    process.exit(1);
  }

  const spinner = ora('Uploading file...').start();

  try {
    const stats = await fs.stat(file);
    const filename = file.split('/').pop()!;

    // Detect content type (basic implementation)
    let contentType = 'application/octet-stream';
    if (filename.endsWith('.png')) contentType = 'image/png';
    else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) contentType = 'image/jpeg';
    else if (filename.endsWith('.pdf')) contentType = 'application/pdf';
    else if (filename.endsWith('.txt')) contentType = 'text/plain';

    // Get presigned upload URL
    const uploadData: any = await generateUploadUrl(appId, filename, contentType, stats.size, options.public);

    // Read file and upload to S3
    const fileBuffer = await fs.readFile(file);

    const uploadResponse = await fetch(uploadData.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
      body: fileBuffer,
    });

    if (!uploadResponse.ok) {
      throw new Error('Failed to upload file to storage');
    }

    spinner.succeed('File uploaded');
    console.log(chalk.green('\n✓ File uploaded successfully!'));
    console.log(chalk.gray(`  Object ID: ${uploadData.objectId}`));
    console.log(chalk.gray(`  Object Key: ${uploadData.objectKey}`));
  } catch (error) {
    spinner.fail('Failed to upload file');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function storageDeleteCommand(objectId: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);

  if (!objectId) {
    console.log(chalk.red('✗ Object ID is required'));
    console.log(chalk.gray('Usage: butterbase storage delete <object-id>'));
    process.exit(1);
  }

  const spinner = ora('Deleting object...').start();

  try {
    await deleteStorageObject(appId, objectId);
    spinner.succeed('Object deleted');
  } catch (error) {
    spinner.fail('Failed to delete object');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function storageConfigCommand(options: { app?: string; publicRead?: string }) {
  const appId = await requireAppId(options.app);

  if (options.publicRead !== undefined) {
    // Update storage config
    if (!['true', 'false'].includes(options.publicRead)) {
      console.log(chalk.red('✗ --public-read must be "true" or "false"'));
      process.exit(1);
    }
    const publicReadEnabled = options.publicRead === 'true';
    const spinner = ora('Updating storage configuration...').start();

    try {
      const response: any = await updateStorageConfig(appId, { publicReadEnabled });
      spinner.succeed('Storage configuration updated');
      console.log(chalk.green(`\n✓ publicReadEnabled: ${response.storage_config.publicReadEnabled}`));
    } catch (error) {
      spinner.fail('Failed to update storage configuration');
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  } else {
    // Show current storage config
    const spinner = ora('Fetching storage configuration...').start();

    try {
      const response: any = await getAppConfig(appId);
      spinner.stop();

      const storageConfig = response.storage_config || {};
      console.log(chalk.blue('\nStorage configuration:\n'));
      console.log(chalk.bold('  publicReadEnabled:'), storageConfig.publicReadEnabled ? chalk.green('true') : chalk.yellow('false'));
      console.log(chalk.bold('  maxFileSizeMb:'), chalk.gray(storageConfig.maxFileSizeMb ?? 10));
      console.log(chalk.bold('  allowedContentTypes:'), chalk.gray(JSON.stringify(storageConfig.allowedContentTypes ?? ['*/*'])));
    } catch (error) {
      spinner.fail('Failed to fetch storage configuration');
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  }
}
