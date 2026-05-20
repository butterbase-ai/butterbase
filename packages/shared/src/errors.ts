export class AppProvisioningError extends Error {
  constructor(message: string, public readonly appId?: string) {
    super(message);
    this.name = 'AppProvisioningError';
  }
}

export class DatabaseConnectionError extends Error {
  constructor(message: string, public readonly host?: string) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}

export class MigrationError extends Error {
  constructor(message: string, public readonly filename?: string) {
    super(message);
    this.name = 'MigrationError';
  }
}
