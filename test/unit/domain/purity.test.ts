import { describe, expect, test } from 'bun:test';
import { dirname, relative, resolve, sep } from 'node:path';

const DOMAIN_DIR = resolve(import.meta.dir, '../../../src/domain');

/** The only third-party imports the domain may have, per file (ARCHITECTURE §1). */
const ALLOWED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  'money.ts': ['decimal.js'],
};

const IMPORT_SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

async function domainFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: DOMAIN_DIR })) {
    files.push(file.split(sep).join('/'));
  }
  return files.sort();
}

describe('domain layer', () => {
  test('has source files', async () => {
    expect((await domainFiles()).length).toBeGreaterThan(0);
  });

  test('imports nothing outside the domain, except decimal.js in money.ts', async () => {
    const violations: string[] = [];

    for (const file of await domainFiles()) {
      const absolute = resolve(DOMAIN_DIR, file);
      const source = await Bun.file(absolute).text();

      for (const [, specifier] of source.matchAll(IMPORT_SPECIFIER)) {
        if (specifier === undefined) continue;

        if (specifier.startsWith('.')) {
          const target = relative(DOMAIN_DIR, resolve(dirname(absolute), specifier));
          if (target.startsWith('..')) violations.push(`${file} → ${specifier}`);
          continue;
        }

        if (!(ALLOWED_PACKAGES[file] ?? []).includes(specifier)) {
          violations.push(`${file} → ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
