import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, resolveToken, UsageRequested } from '../src/main.js';

const HOME = mkdtempSync(path.join(tmpdir(), 'telrad-agent-cli-'));
const base = ['--watch', HOME, '--api', 'https://telrad.test'];

describe('the arguments', () => {
  it('takes the two it must have and defaults the rest', () => {
    const cfg = parseArgs(base, {});
    expect(cfg).toMatchObject({
      watch: HOME, api: 'https://telrad.test', once: false, dryRun: false, logNames: false,
      settleSeconds: 60, intervalSeconds: 20, timeoutMs: 120_000,
      state: path.join(HOME, 'telrad-agent-state.json'),
    });
  });

  it('resolves the watch folder, so a cursor moved between crons cannot mean something else', () => {
    expect(path.isAbsolute(parseArgs(['--watch', '.', '--api', 'https://x.test'], {}).watch)).toBe(true);
  });

  it('refuses to run without a folder, because a wrong root would scan the disk', () => {
    expect(() => parseArgs(['--api', 'https://x.test'], {})).toThrow(/--watch is required/);
  });

  it('refuses to run without an api, rather than guessing localhost', () => {
    expect(() => parseArgs(['--watch', HOME], {})).toThrow(/no api given/);
  });

  it('reads the api from the environment when the flag is not given', () => {
    expect(parseArgs(['--watch', HOME], { TELRAD_API_URL: 'https://pacs.example' }).api)
      .toBe('https://pacs.example');
  });

  it('rejects an unknown flag instead of ignoring a misspelled one', () => {
    // A typo is how an operator ends up with an agent that is not doing what they think it is.
    expect(() => parseArgs([...base, '--setl'], {})).toThrow(/unknown argument --setl/);
  });

  it('rejects a flag with no value rather than swallowing the next flag', () => {
    expect(() => parseArgs([...base, '--settle'], {})).toThrow(/--settle needs a value/);
    expect(() => parseArgs(['--watch'], {})).toThrow(/--watch needs a value/);
  });

  it('rejects a nonsense number instead of settling for zero seconds forever', () => {
    expect(() => parseArgs([...base, '--settle', 'abc'], {})).toThrow(/must be a number/);
    expect(() => parseArgs([...base, '--interval', '-5'], {})).toThrow(/must be a number/);
  });

  it('parses the hints template at the argument, so an invalid one never reaches a scan', () => {
    expect(() => parseArgs([...base, '--hints', '{patient}'], {})).toThrow(/unknown token/);
    expect(parseArgs([...base, '--hints', '{accession}'], {}).hints).toEqual([{ kind: 'accession' }]);
  });

  it('does not swallow the flag that follows one which takes a value', () => {
    // The first version of this parser advanced twice for a value flag and once for a boolean, so
    // `--once --dry-run` dropped `--dry-run` and sent real files in what the operator believed was
    // a rehearsal. The live run caught it on the second flag it tried.
    const cfg = parseArgs([...base, '--settle', '5', '--dry-run', '--once', '--log-names',
      '--hints', '{accession}'], {});
    expect(cfg).toMatchObject({
      settleSeconds: 5, dryRun: true, once: true, logNames: true,
      hints: [{ kind: 'accession' }],
    });
  });

  it('prints the usage on --help as a success', () => {
    expect(() => parseArgs([...base, '--help'], {})).toThrow(UsageRequested);
  });

  it('allows cleartext through the environment only with the same care as the flag', () => {
    expect(parseArgs(base, { TELRAD_ALLOW_INSECURE_HTTP: '1' }).allowInsecureHttp).toBe(true);
    expect(parseArgs(base, {}).allowInsecureHttp).toBe(false);
  });
});

describe('the credential', () => {
  it('is refused on the command line, where every account on the machine can read it', () => {
    expect(() => parseArgs([...base, '--token', 'abc'], {})).toThrow(/process list/);
  });

  it('comes from a file when one is given', () => {
    const file = path.join(HOME, 'token.txt');
    writeFileSync(file, '  site-token-value\n', 'utf8');
    expect(resolveToken(parseArgs([...base, '--token-file', file], {}), {})).toBe('site-token-value');
  });

  it('comes from the environment otherwise', () => {
    expect(resolveToken(parseArgs(base, {}), { TELRAD_AGENT_TOKEN: 'env-token' })).toBe('env-token');
  });

  it('fails loudly when neither is set, rather than sending anonymous requests', () => {
    expect(() => resolveToken(parseArgs(base, {}), {})).toThrow(/no token/);
  });

  it('fails on a token file that is empty, which is a placeholder somebody forgot to fill', () => {
    const file = path.join(HOME, 'empty.txt');
    writeFileSync(file, '\n', 'utf8');
    expect(() => resolveToken(parseArgs([...base, '--token-file', file], {}), {})).toThrow(/is empty/);
  });

  it('fails on a token file that does not exist instead of falling back to no auth', () => {
    expect(() => resolveToken(parseArgs([...base, '--token-file', path.join(HOME, 'nope')])))
      .toThrow(/no such file|ENOENT/);
  });
});
