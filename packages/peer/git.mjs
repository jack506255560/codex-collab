import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function git(cwd, ...args) {
  try {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    // Keep stderr available to callers that can turn it into a safe, actionable message.
    // Never expose the raw value directly to the browser: it may contain credentials.
    error.git_args = args;
    throw error;
  }
}
