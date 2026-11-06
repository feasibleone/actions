'use strict';
// Retention rules for a published reports site.
//
// Kept apart from `index.mjs` so they can be tested without a git remote: the
// action itself only resolves inputs, stages directories, and pushes, while the
// questions that decide the size of the site — which runs to keep, which of them
// keep their heavy artefacts, what an alias directory holds — are answered here.
//
// Three windows, because the three kinds of file age differently:
//
//   - **a run directory** is cheap to keep: its JSON is a few kilobytes and it is
//     what `blong-dev ci history` reads to compare a package across runs;
//   - **a trace archive** is 5-7 MB and is only ever opened while a failure is
//     being investigated, which is the newest run or two;
//   - **a rendered report page** carries the whole report, attachments included,
//     and is 1-11 MB — and every fact in it a tool needs is already in the JSON
//     beside it.
//
// So the runs are pruned by `keep-reports`, and *within* the retained runs the
// heavy files are pruned by `keep-heavy`: an older run keeps its JSON, its markdown
// and a stub page that links to them, and loses the bytes nobody re-opens.
const {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} = require('node:fs');
const {join} = require('node:path');

/** A numeric run directory; aliases are not one, so they are never pruned. */
const RUN_DIR = /^\d+$/;

/** Directories whose contents are the byte bulk of a run. */
const HEAVY_DIRS = ['traces'];

/**
 * How many run directories a tool keeps.
 *
 * `keepReports` is either one number for every tool, or an object with a `default`
 * and per-tool overrides — the coverage HTML is 20 MB of a run and fifteen of them
 * is most of the site, while a package page costs a fraction of that.
 */
function keepFor(tool, keepReports) {
    if (typeof keepReports === 'number') return keepReports;
    if (!keepReports || typeof keepReports !== 'object') return 15;
    const own = Number(keepReports[tool]);
    if (Number.isFinite(own) && own >= 1) return Math.floor(own);
    const fallback = Number(keepReports.default);
    return Number.isFinite(fallback) && fallback >= 1 ? Math.floor(fallback) : 15;
}

/** The numeric run directories under `root`, oldest first. */
function listRuns(root) {
    if (!existsSync(root)) return [];
    return readdirSync(root, {withFileTypes: true})
        .filter((entry) => entry.isDirectory() && RUN_DIR.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => Number(a) - Number(b));
}

/**
 * Delete every run directory beyond the newest `keep`.
 *
 * Returns the names removed, so the caller can report them. A directory that is not
 * numeric is never touched: that is where an alias lives.
 */
function pruneRuns(root, keep) {
    const runs = listRuns(root);
    const drop = runs.slice(0, Math.max(0, runs.length - keep));
    for (const run of drop) rmSync(join(root, run), {recursive: true, force: true});
    return drop;
}

/**
 * Remove the heavy artefacts of every run older than the newest `keep`.
 *
 * The run directory and its small files stay: a reader follows the stub page, and a
 * tool reads the JSON. Returns the names stripped.
 */
function pruneHeavy(root, keep) {
    const runs = listRuns(root);
    const strip = runs.slice(0, Math.max(0, runs.length - keep));
    for (const run of strip) stripHeavy(join(root, run));
    return strip;
}

/** Drop a run's trace archives and replace its rendered page with a stub. */
function stripHeavy(runDir) {
    for (const name of HEAVY_DIRS) rmSync(join(runDir, name), {recursive: true, force: true});
    const page = join(runDir, 'index.html');
    if (!existsSync(page)) return;
    // A page that is already small (a stub written by an earlier run, or a package
    // whose report is a handful of tables) is left alone: rewriting it every run
    // would make every publish a commit for no bytes.
    if (statSync(page).size <= STUB_LIMIT) return;
    writeFileSync(page, stubPage(runDir));
}

/** A page up to this size is a summary already, not a report carrying attachments. */
const STUB_LIMIT = 64 * 1024;

/**
 * The page an old run keeps: what the run was, and what of it is still here.
 *
 * It is deliberately plain — no renderer, no data — because the point of stripping
 * the run is that nothing will re-open it, and a link that answers with the JSON is
 * better than one that 404s.
 */
function stubPage(runDir) {
    const files = readdirSync(runDir, {withFileTypes: true})
        .filter((entry) => entry.isFile() && entry.name !== 'index.html')
        .map((entry) => entry.name)
        .sort();
    const links = files.map((name) => `<li><a href="${name}">${name}</a></li>`).join('\n');
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        '<title>Report pruned</title>' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '</head><body><h1>Report pruned</h1>' +
        '<p>This run is kept for its results, not for its report: the rendered page and ' +
        'its trace archives were pruned when the reports site moved on to newer runs. ' +
        'The summary below is what the run still answers.</p>' +
        (links ? `<ul>\n${links}\n</ul>` : '<p>No files are left in this run.</p>') +
        '<p><a href="../">All runs</a></p>' +
        '</body></html>\n'
    );
}

/**
 * Point an alias directory at the run it names.
 *
 * It used to be a recursive copy of the whole run, which put a second copy of every
 * trace archive and of the rendered page on the site — and, through the `failures`
 * alias, a third. A pointer is what the alias means: the redirect serves a reader,
 * and the copied JSON keeps the contract a tool depends on
 * (`failures/<workflow>/latest/failures.json`).
 */
function writeAlias(aliasDir, runNum) {
    rmSync(aliasDir, {recursive: true, force: true});
    mkdirSync(aliasDir, {recursive: true});
    const runDir = join(aliasDir, '..', String(runNum));
    // The alias is a sibling of the run directories, so the redirect is one hop.
    writeFileSync(
        join(aliasDir, 'index.html'),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
            '<title>Latest report</title>' +
            `<meta http-equiv="refresh" content="0; url=../${runNum}/">` +
            '</head><body>' +
            `<p>Redirecting to <a href="../${runNum}/">run ${runNum}</a>.</p>` +
            '</body></html>\n',
    );
    if (!existsSync(runDir)) return [];
    const copied = [];
    for (const entry of readdirSync(runDir, {withFileTypes: true})) {
        // The small files only: an alias that carried the page and the traces is the
        // duplicate this exists to avoid.
        if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
        writeFileSync(join(aliasDir, entry.name), readFileSync(join(runDir, entry.name)));
        copied.push(entry.name);
    }
    return copied;
}

/** Copy a file or a directory tree. */
function copyRecursive(src, dst) {
    if (statSync(src).isDirectory()) {
        mkdirSync(dst, {recursive: true});
        for (const entry of readdirSync(src)) copyRecursive(join(src, entry), join(dst, entry));
    } else {
        copyFileSync(src, dst);
    }
}

module.exports = {
    HEAVY_DIRS,
    STUB_LIMIT,
    copyRecursive,
    keepFor,
    listRuns,
    pruneHeavy,
    pruneRuns,
    stripHeavy,
    stubPage,
    writeAlias,
};
