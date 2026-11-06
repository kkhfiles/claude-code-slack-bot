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

type Command = (file: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
const command: Command = (file, args, cwd) => new Promise(resolve => {
  execFile(file, args, { cwd, timeout: 60_000, windowsHide: true, shell: false,
    encoding: 'utf8', maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } },
  (error, stdout) => resolve({ code: error ? 1 : 0, stdout: stdout || '' }));
});

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
