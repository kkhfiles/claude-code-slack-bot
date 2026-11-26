/** Discovery acceptance is checked by the same deterministic Python gate as M12. */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pythonCommand } from './python-command';

export interface DiscoverySettings {
  execute?: boolean;
  questions?: string;
  journal?: string;
  runRoot?: string;
  repetitions?: number;
  minimumUnits?: number;
  publication?: { enabled: boolean; repoRoot?: string; safetyChecker?: string };
}

export interface DiscoveryGateResult { ok: boolean; errors: string[]; unknown?: boolean }

export function discoverySettings(value: unknown): DiscoverySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: DiscoverySettings = { execute: source.execute === true };
  for (const key of ['questions', 'journal', 'runRoot'] as const) {
    if (typeof source[key] === 'string' && source[key]) result[key] = source[key];
  }
  for (const key of ['repetitions', 'minimumUnits'] as const) {
    if (typeof source[key] === 'number' && Number.isSafeInteger(source[key]) && source[key] > 0) result[key] = source[key];
  }
  if (source.publication && typeof source.publication === 'object' && !Array.isArray(source.publication)) {
    const publication = source.publication as Record<string, unknown>;
    result.publication = { enabled: publication.enabled === true };
    for (const key of ['repoRoot', 'safetyChecker'] as const) {
      if (typeof publication[key] === 'string') result.publication[key] = publication[key];
    }
  }
  return result;
}

export function discoveryRunnerArgs(value: unknown): string[] {
  const settings = discoverySettings(value);
  const args: string[] = [];
  for (const [key, flag] of [['questions', '--questions'], ['journal', '--journal'], ['runRoot', '--run-root']] as const) {
    if (typeof settings[key] === 'string' && settings[key]) args.push(flag, settings[key]!);
  }
  for (const [key, flag] of [['repetitions', '--repetitions'], ['minimumUnits', '--minimum-units']] as const) {
    if (Number.isSafeInteger(settings[key]) && settings[key]! > 0) args.push(flag, String(settings[key]));
  }
  if (settings.execute === true) {
    if (!settings.runRoot || !settings.questions || !Number.isSafeInteger(settings.repetitions) || settings.repetitions! < 1
        || !Number.isSafeInteger(settings.minimumUnits) || settings.minimumUnits! < 1) {
      throw new Error('discovery collection requires confirmed questions, repetitions and minimumUnits');
    }
    args.push('--execute');
  }
  return args;
}

type Command = (file: string, args: string[], cwd: string, timeout?: number) => Promise<{ code: number; stdout: string }>;
const command: Command = (file, args, cwd, timeout = 60_000) => new Promise(resolve => {
  execFile(file, args, { cwd, timeout, windowsHide: true, shell: false,
    encoding: 'utf8', maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } },
  (error, stdout) => resolve({ code: error ? 1 : 0, stdout: stdout || '' }));
});

export async function publishDiscoveryRound(
  slot: string, value: unknown, execute: Command = command,
): Promise<'disabled' | 'published' | 'already-current' | 'failed'> {
  const settings = discoverySettings(value);
  const publication = settings.publication;
  if (!publication?.enabled) return 'disabled';
  const { repoRoot, safetyChecker } = publication;
  if (!repoRoot || !safetyChecker || !settings.runRoot || !/^\d{4}-\d{2}-\d{2}$/.test(slot)
      || ![repoRoot, safetyChecker, settings.runRoot].every(value => path.isAbsolute(value))) return 'failed';
  try {
    const response = await execute(pythonCommand('python'), ['-X', 'utf8',
      path.join(repoRoot, 'tools', 'publish_b2a_weekly_tests.py'), '--slot', slot,
      '--runs', settings.runRoot, '--safety-checker', safetyChecker], repoRoot, 20 * 60_000);
    const result = JSON.parse(response.stdout.trim());
    if (response.code === 0 && result.slot === slot && /^[a-f0-9]{40}$/.test(result.commit)
        && (result.status === 'published' || result.status === 'already-current')) return result.status;
  } catch { /* Report storage stays complete; the scheduler reports publication failure separately. */ }
  return 'failed';
}

function restorePending(out: string): void {
  try {
    const text = fs.readFileSync(out, 'utf8');
    if (text.trim() && !text.includes('<!-- judgment: pending -->')) {
      fs.writeFileSync(out, '<!-- judgment: pending -->\n' + text, 'utf8');
    }
  } catch { /* The caller still forces partial; absence is separately monitored. */ }
}

export async function gateDiscoveryReport(
  workflowRoot: string, run: { slot: string; out: string }, value: unknown,
  execute: Command = command,
): Promise<DiscoveryGateResult> {
  const settings = discoverySettings(value);
  if (!settings.runRoot) {
    restorePending(run.out);
    return { ok: false, errors: ['discovery runRoot must be supplied by private runtime configuration'] };
  }
  const root = settings.runRoot;
  const runDir = path.join(root, run.slot);
  const args = ['-X', 'utf8', '-m', 'batch.discovery_weekly', '--check-final', '--date', run.slot,
    '--run-root', root, '--out', run.out,
    '--judgement', path.join(runDir, 'judgement.json'),
    '--verification', path.join(runDir, 'verification.json')];
  if (Number.isSafeInteger(settings.minimumUnits) && settings.minimumUnits! > 0) {
    args.push('--minimum-units', String(settings.minimumUnits));
  }
  let result: DiscoveryGateResult;
  try {
    const response = await execute(pythonCommand('python'), args, path.join(workflowRoot, 'mycelium'));
    const parsed = JSON.parse(response.stdout.trim());
    result = response.code === 0 && parsed.ok === true
      ? { ok: true, errors: [] }
      : { ok: false, errors: Array.isArray(parsed.errors) ? parsed.errors : ['discovery final check failed'], unknown: parsed.unknown === true };
  } catch {
    result = { ok: false, errors: ['discovery final check could not be read'], unknown: true };
  }
  // Even if Python failed before restoring pending, sweep must see an unfinished report.
  if (!result.ok) {
    restorePending(run.out);
  }
  return result;
}
