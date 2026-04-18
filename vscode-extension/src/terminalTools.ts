import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TerminalRunResult {
  output: string;
  exitCode: number;
}

export async function executeInTerminal(command: string, cwd: string): Promise<TerminalRunResult> {
  const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: 'Local tab agent', cwd });
  terminal.show(true);
  terminal.sendText(command);

  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 30000 });
    const out = stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
    return { output: out, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    const code = typeof e.code === 'number' ? e.code : 1;
    const out = `Error: ${e.message}\n${e.stdout || ''}${e.stderr || ''}`;
    return { output: out, exitCode: code };
  }
}
