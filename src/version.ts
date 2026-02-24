import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

interface VersionInfo {
  version: string;
  gitHash: string | null;
  gitDate: string | null;
}

interface UpdateCheckResult {
  behindBy: number;
  latestHash: string;
}

/**
 * Read the version string from package.json.
 */
export function getVersion(): string {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return pkg.version ?? 'unknown';
}

/**
 * Return version + git commit hash + git commit date.
 * Gracefully falls back if git is unavailable.
 */
export function getVersionInfo(): VersionInfo {
  const version = getVersion();
  let gitHash: string | null = null;
  let gitDate: string | null = null;

  try {
    gitHash = execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    gitDate = execSync('git log -1 --format=%cs', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // git not available or not a git repo — that's fine
  }

  return { version, gitHash, gitDate };
}

/**
 * Check if there are newer commits on origin/main.
 * Returns the number of commits behind, or null on failure.
 * Applies a 15-second timeout to avoid blocking.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult | null> {
  const cwd = path.join(__dirname, '..');

  try {
    // Fetch latest from origin (quiet, 15s timeout)
    execSync('git fetch origin main --quiet', {
      cwd,
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Count commits we're behind
    const behindStr = execSync('git rev-list --count HEAD..origin/main', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const behindBy = parseInt(behindStr, 10);
    if (isNaN(behindBy)) return null;

    let latestHash = '';
    if (behindBy > 0) {
      latestHash = execSync('git rev-parse --short origin/main', {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    }

    return { behindBy, latestHash };
  } catch {
    return null;
  }
}
