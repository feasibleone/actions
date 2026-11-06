'use strict';
// The retention rules decide how large the published site is, so they are asserted
// against a real directory tree rather than a mock: what matters is which files are
// gone afterwards, not which functions were called.
const {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} =
    require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {afterEach, beforeEach, describe, expect, test} = require('@jest/globals');

const {
    STUB_LIMIT,
    copyRecursive,
    keepFor,
    listRuns,
    pruneHeavy,
    pruneRuns,
    stripHeavy,
    writeAlias,
} = require('./lib');

let root;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deploy-report-'));
});

afterEach(() => {
    rmSync(root, {recursive: true, force: true});
});

/** A run directory as the report artifact stages it. */
function makeRun(parent, run, {page = 'x'.repeat(STUB_LIMIT + 10), trace = true} = {}) {
    const dir = join(parent, run);
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'summary.json'), '{"status":"passed"}\n');
    writeFileSync(join(dir, 'index.html'), page);
    if (trace) {
        mkdirSync(join(dir, 'traces'), {recursive: true});
        writeFileSync(join(dir, 'traces', 'a.zip'), 'zip');
    }
    return dir;
}

describe('keepFor', () => {
    test('one number applies to every tool', () => {
        expect(keepFor('coverage', 15)).toBe(15);
    });

    test('a map keeps a tool for fewer runs than the rest', () => {
        const keep = {default: 15, coverage: 2};
        expect(keepFor('blong-access', keep)).toBe(15);
        expect(keepFor('coverage', keep)).toBe(2);
    });

    test('a tool missing from the map takes the default', () => {
        expect(keepFor('failures', {default: 5})).toBe(5);
    });

    test('junk falls back to fifteen rather than keeping nothing', () => {
        expect(keepFor('x', null)).toBe(15);
        expect(keepFor('x', {default: 0})).toBe(15);
        expect(keepFor('x', {default: 'lots'})).toBe(15);
    });
});

describe('listRuns', () => {
    test('is numeric, not lexical, and ignores an alias and a file', () => {
        for (const name of ['9', '10', '100', 'latest']) mkdirSync(join(root, name));
        writeFileSync(join(root, 'notes.txt'), 'x');
        expect(listRuns(root)).toEqual(['9', '10', '100']);
    });

    test('is empty for a directory that is not there', () => {
        expect(listRuns(join(root, 'missing'))).toEqual([]);
    });
});

describe('pruneRuns', () => {
    test('keeps the newest runs and returns what it removed', () => {
        for (const run of ['1', '2', '3', '4']) makeRun(root, run);
        mkdirSync(join(root, 'latest'));
        expect(pruneRuns(root, 2)).toEqual(['1', '2']);
        expect(readdirSync(root).sort()).toEqual(['3', '4', 'latest']);
    });

    test('an alias is never pruned', () => {
        makeRun(root, '1');
        mkdirSync(join(root, 'latest'));
        pruneRuns(root, 1);
        expect(existsSync(join(root, 'latest'))).toBe(true);
    });
});

describe('stripHeavy', () => {
    test('removes the traces and leaves a stub that still links the JSON', () => {
        const dir = makeRun(root, '7');
        stripHeavy(dir);
        expect(existsSync(join(dir, 'traces'))).toBe(false);
        const page = readFileSync(join(dir, 'index.html'), 'utf8');
        expect(page.length).toBeLessThan(STUB_LIMIT);
        expect(page).toContain('href="summary.json"');
        expect(page).toContain('href="../"');
        expect(readFileSync(join(dir, 'summary.json'), 'utf8')).toContain('passed');
    });

    test('leaves a page that is already a summary alone', () => {
        const dir = makeRun(root, '7', {page: '<html>small</html>'});
        stripHeavy(dir);
        expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<html>small</html>');
    });

    test('survives a run whose page never arrived', () => {
        const dir = join(root, '8');
        mkdirSync(dir, {recursive: true});
        writeFileSync(join(dir, 'summary.json'), '{}\n');
        expect(() => stripHeavy(dir)).not.toThrow();
    });
});

describe('pruneHeavy', () => {
    test('strips every run older than the window and keeps the newest intact', () => {
        for (const run of ['1', '2', '3']) makeRun(root, run);
        expect(pruneHeavy(root, 2)).toEqual(['1']);
        expect(existsSync(join(root, '1', 'traces'))).toBe(false);
        expect(existsSync(join(root, '2', 'traces'))).toBe(true);
        expect(existsSync(join(root, '3', 'traces'))).toBe(true);
        expect(readFileSync(join(root, '3', 'index.html'), 'utf8').length).toBeGreaterThan(
            STUB_LIMIT,
        );
    });

    test('zero strips every retained run', () => {
        for (const run of ['1', '2']) makeRun(root, run);
        expect(pruneHeavy(root, 0)).toEqual(['1', '2']);
    });
});

describe('writeAlias', () => {
    test('points at the run instead of copying it, and keeps the JSON contract', () => {
        makeRun(root, '12');
        mkdirSync(join(root, 'latest'), {recursive: true});
        writeFileSync(join(root, 'latest', 'stale.json'), '{}');

        expect(writeAlias(join(root, 'latest'), '12')).toEqual(['summary.json']);

        const page = readFileSync(join(root, 'latest', 'index.html'), 'utf8');
        expect(page).toContain('url=../12/');
        expect(readFileSync(join(root, 'latest', 'summary.json'), 'utf8')).toContain('passed');
        // The duplicate this replaced: neither the trace archives nor the run's page.
        expect(existsSync(join(root, 'latest', 'traces'))).toBe(false);
        expect(readFileSync(join(root, 'latest', 'index.html'), 'utf8')).not.toContain(
            'x'.repeat(STUB_LIMIT),
        );
        // A file the previous alias carried and this run does not is gone.
        expect(existsSync(join(root, 'latest', 'stale.json'))).toBe(false);
    });

    test('copies the failures bundle as well, which is the file an agent reads', () => {
        const dir = makeRun(root, '34');
        writeFileSync(join(dir, 'failures.json'), '{"failures":[]}\n');
        expect(writeAlias(join(root, 'latest'), '34').sort()).toEqual([
            'failures.json',
            'summary.json',
        ]);
    });

    test('writes the redirect even when the run directory is gone', () => {
        expect(writeAlias(join(root, 'latest'), '99')).toEqual([]);
        expect(readFileSync(join(root, 'latest', 'index.html'), 'utf8')).toContain(
            'url=../99/',
        );
    });
});

describe('copyRecursive', () => {
    test('copies a tree', () => {
        const src = join(root, 'src');
        mkdirSync(join(src, 'traces'), {recursive: true});
        writeFileSync(join(src, 'a.json'), '{}');
        writeFileSync(join(src, 'traces', 'b.zip'), 'zip');
        copyRecursive(src, join(root, 'dst'));
        expect(readFileSync(join(root, 'dst', 'traces', 'b.zip'), 'utf8')).toBe('zip');
    });
});
