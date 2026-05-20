# Security Policy

## Reporting a vulnerability

Please report security issues privately to **security@butterbase.ai**. We aim to acknowledge within two business days.

Please do not file public GitHub issues for security vulnerabilities.

When reporting, include:

- Affected component and version (commit SHA if applicable)
- Reproduction steps
- Impact assessment if you have one

We will work with you on a coordinated disclosure timeline before any public discussion.

## Supported versions

The latest tagged release on `main` receives security updates. We do not currently backport fixes to older minor versions.

## Operational notes for self-hosters

- **`BUTTERBASE_E2E=1` is a test-only auth bypass.** The control-api refuses to start when this is set alongside `NODE_ENV=production`, but the bypass mechanism is visible in the source. Never set this variable on any internet-reachable host.
- The default control-api configuration accepts unauthenticated requests on internal endpoints intended for in-cluster service-to-service traffic. Make sure those ports are not exposed publicly. See `SETUP.md`.
- Storage signed URLs use a signing secret; rotate it if you suspect exposure.
- The AI gateway, when no upstream `RouterAdapter` is registered, returns errors rather than calling external providers. Wire your own adapter (with your own API keys) before pointing real traffic at it.
