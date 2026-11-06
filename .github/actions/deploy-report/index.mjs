#!/usr/bin/env node
// Publish a run's report directories to a <owner>/<repo> gh-pages branch and emit their URLs.
//
// The whole run goes out in **one commit and one push**: a report per invocation
// would clone, commit and push once per report, and every push to the same branch
// cancels the Pages build the previous push started.
//
// Two JSON inputs drive it:
//   - `reports`: array of {"tool","src"} — one entry per report directory of the
//     run, all of them copied and pushed together;
//   - `aliases`: object {"<tool>": "<alias>"} naming the tools that must answer on a
//     stable URL. A tool that reported this run has its alias mirrored to the run; a
//     tool named there that did *not* report has its alias dropped in the same
//     commit, so a URL handed to an agent never keeps answering with a stale
//     report.
//   - `assets`: array of {"src","dest"} — directories copied once into the site
//     root, for the files every report references and none should carry (the
//     content-addressed Allure application bundle).
//
// Also: clone (or init) the gh-pages branch, copy docs/<tool>/<workflow>/<run>,
// touch .nojekyll, prune numeric run dirs beyond keep-reports, strip the heavy
// artefacts (trace archives, rendered page) of the runs beyond keep-heavy, point
// the aliases at the run instead of copying it, regenerate index.html at docs,
// docs/<tool> and docs/<tool>/<workflow>, resolve the pages base URL
// (custom-domain aware), and commit + force push.
import {existsSync} from 'node:fs';
import {mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    copyRecursive,
    keepFor,
    pruneHeavy,
    pruneRuns,
    writeAlias,
} from './lib.js';

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const currentRepo = process.env.GITHUB_REPOSITORY || '';

// --- Resolve inputs ------------------------------------------------------------
const extRepo = (process.env.INPUT_EXT_REPO || '').trim() || currentRepo;
const workflow = (process.env.INPUT_WORKFLOW || '').trim();
const runNum = (process.env.INPUT_RUN_NUM || '').trim();
const keepReports = parseJson('keep-reports', process.env.INPUT_KEEP_REPORTS, 15);
// Blank means the documented default rather than "strip everything": an input the
// caller left empty is not an instruction to delete the heavy artefacts of every run.
const keepHeavyInput = (process.env.INPUT_KEEP_HEAVY ?? '').trim();
const keepHeavy = keepHeavyInput === '' ? 2 : Math.max(0, Number(keepHeavyInput) || 0);
const reportToken = (process.env.INPUT_REPORT_TOKEN || '').trim();

const token = extRepo === currentRepo ? (process.env.GITHUB_TOKEN || '').trim() : reportToken;

function setOutput(name, value) {
    const file = process.env.GITHUB_OUTPUT;
    if (file) writeFileSync(file, `${name}=${value}\n`, {flag: 'a'});
}

function fail(message) {
    console.error(`deploy-report: ${message}`);
    setOutput('deployed', 'false');
    process.exit(1);
}

function parseJson(name, raw, fallback) {
    const text = (raw || '').trim();
    if (!text) return fallback;
    try {
        return JSON.parse(text);
    } catch (err) {
        return fail(`${name} is not valid JSON: ${err.message}`);
    }
}

const reports = parseJson('reports', process.env.INPUT_REPORTS, []);
const aliases = parseJson('aliases', process.env.INPUT_ALIASES, {});
const sharedAssets = parseJson('assets', process.env.INPUT_ASSETS, []);

// --- Validate ------------------------------------------------------------------
if (!Array.isArray(reports)) fail('reports must be a JSON array of {tool, src}');
if (typeof aliases !== 'object' || aliases === null || Array.isArray(aliases))
    fail('aliases must be a JSON object of {tool: alias}');
if (!Array.isArray(sharedAssets)) fail('assets must be a JSON array of {src, dest}');
// One number for every tool, or `{"default": n, "<tool>": n}`: the coverage HTML
// is twenty megabytes of a run, and fifteen of them is most of the site.
if (
    typeof keepReports !== 'number' &&
    (typeof keepReports !== 'object' || keepReports === null || Array.isArray(keepReports))
)
    fail('keep-reports must be a number or a JSON object of {default, <tool>}');

const problems = [];
if (!workflow) problems.push('workflow');
if (reports.length && !runNum) problems.push('run-num');
for (const [i, entry] of reports.entries()) {
    if (!String((entry && entry.tool) || '').trim()) problems.push(`reports[${i}].tool`);
    if (!String((entry && entry.src) || '').trim()) problems.push(`reports[${i}].src`);
}
for (const [i, entry] of sharedAssets.entries()) {
    if (!String((entry && entry.src) || '').trim()) problems.push(`assets[${i}].src`);
    if (!String((entry && entry.dest) || '').trim()) problems.push(`assets[${i}].dest`);
}
const aliasTools = Object.entries(aliases).map(([name, alias]) => [String(name).trim(), String(alias).trim()]);
for (const [name, alias] of aliasTools) {
    if (!name) problems.push('aliases.<tool>');
    if (!alias) problems.push(`aliases.${name}`);
    // A numeric alias would collide with the run directories the pruner deletes.
    if (/^\d+$/.test(alias)) problems.push(`aliases.${name} (numeric)`);
}
if (problems.length) fail(`missing or invalid input: ${problems.join(', ')}`);
if (!token) {
    console.log(`::warning::No token available to publish to ${extRepo} (set REPORT_TOKEN for an external reports repo) — skipping deploy`);
    setOutput('deployed', 'false');
    process.exit(0);
}
if (!reports.length) {
    console.log('deploy-report: reports is empty — nothing to publish');
    setOutput('deployed', 'false');
    process.exit(0);
}

const [owner, extName] = extRepo.split('/');
const pagesBranch = 'gh-pages';
const authUrl = `https://x-access-token:${token}@github.com/${extRepo}.git`;
const work = join(process.env.RUNNER_TEMP || tmpdir(), 'publish-reports');

function run(args, opts = {}) {
    return execFileSync('git', args, {cwd: opts.cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8'});
}
const ok = (args, opts = {}) => {
    try {
        execFileSync('git', args, {...opts, stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
};

// --- Prepare the gh-pages working tree -----------------------------------------
rmSync(work, {recursive: true, force: true});
// The exit code alone is not enough here: ls-remote also succeeds when it matched
// nothing, and cloning a branch that is not there fails hard. An empty reports
// repository (no gh-pages branch yet) is bootstrapped with a fresh branch instead.
if (hasBranch(authUrl, pagesBranch)) {
    run(['clone', '-q', '--depth', '1', '--branch', pagesBranch, authUrl, work], {cwd: undefined});
} else {
    mkdirSync(work, {recursive: true});
    run(['init', '-q'], {cwd: work});
    run(['checkout', '-q', '-b', pagesBranch], {cwd: work});
}
run(['config', 'user.email', 'actions@github.com'], {cwd: work});
run(['config', 'user.name', 'github-actions'], {cwd: work});
run(['config', 'pull.rebase', 'false'], {cwd: work});

// --- Stage this run's reports --------------------------------------------------
const wf = workflow.replace(/\s+/g, '-');
const published = [];
const dropped = [];
const excludes = new Map(); // tool -> alias names hidden from its index
const hide = (name) => {
    if (!excludes.has(name)) excludes.set(name, new Set());
    return excludes.get(name);
};

for (const {tool, src} of reports.map((entry) => ({tool: String(entry.tool).trim(), src: String(entry.src).trim()}))) {
    const runDir = join('docs', tool, wf, runNum);
    mkdirSync(join(work, runDir), {recursive: true});
    const abs = join(workspace, src);
    if (existsSync(abs)) {
        for (const entry of readdirSync(abs)) {
            copyRecursive(join(abs, entry), join(work, runDir, entry));
        }
    } else {
        console.log(`::warning::report source not found: ${src}`);
    }
    writeFileSync(join(work, 'docs', '.nojekyll'), '');
    const droppedRuns = pruneRuns(join(work, 'docs', tool, wf), keepFor(tool, keepReports));
    if (droppedRuns.length) console.log(`Pruned ${droppedRuns.length} old run(s) of ${tool}`);
    published.push(tool);
    hide(tool);
}

// --- Strip the heavy artefacts of the older runs -------------------------------
// A trace archive and a rendered page are the bytes of the site, and both are only
// ever opened while the newest run or two are being looked at. Older runs keep their
// JSON — which is what `blong-dev ci history` compares — and a stub page that links
// to it, so a run directory still answers for itself after losing its report.
for (const tool of published) {
    const stripped = pruneHeavy(join(work, 'docs', tool, wf), keepHeavy);
    if (stripped.length) console.log(`Stripped heavy artefacts of ${stripped.length} old run(s) of ${tool}`);
}

// --- Stage this run's shared assets --------------------------------------------
// Copied into the site root once, after the reports that reference them. A run that
// publishes several reports of one tool would otherwise carry a copy of the Allure
// application bundle in every run directory; here one file serves every report, run and
// workflow, and a browser downloads it once. Existing bundles are kept: a retained run
// published with an older Allure version still references its own.
for (const entry of sharedAssets.map((asset) => ({
    src: String(asset.src).trim(),
    dest: String(asset.dest).trim(),
}))) {
    const abs = join(workspace, entry.src);
    if (!existsSync(abs)) {
        console.log(`::warning::asset source not found: ${entry.src}`);
        continue;
    }
    const dest = join(work, 'docs', entry.dest);
    mkdirSync(dest, {recursive: true});
    for (const name of readdirSync(abs)) copyRecursive(join(abs, name), join(dest, name));
    writeFileSync(join(work, 'docs', '.nojekyll'), '');
}

// --- Maintain the stable aliases -----------------------------------------------
// After pruning, so an alias can never point at a run that was just removed. A
// tool that reported this run points its alias at the run — a redirect plus the
// run's small JSON, not the recursive copy that put a second copy of every trace
// and page on the site; a tool that did not report has its alias dropped (a green
// run publishes no failures bundle, and the previous one must stop answering on
// the stable URL).
for (const [tool, alias] of aliasTools) {
    const aliasDir = join(work, 'docs', tool, wf, alias);
    if (published.includes(tool)) {
        writeAlias(aliasDir, runNum);
    } else if (existsSync(aliasDir)) {
        rmSync(aliasDir, {recursive: true, force: true});
        dropped.push(`${tool}/${alias}`);
    }
    hide(tool).add(alias);
}

// --- Regenerate index.html at each level ---------------------------------------
for (const [tool, exclude] of excludes) {
    const root = join(work, 'docs', tool, wf);
    if (!existsSync(root)) continue;
    genIndex(root, `${tool} — ${wf}`, exclude);
    genIndex(join(work, 'docs', tool), `${tool} reports`);
}
if (existsSync(join(work, 'docs'))) genIndex(join(work, 'docs'), 'Reports', new Set(['_assets']));

// --- Commit + force push, once for the whole run --------------------------------
run(['add', '-A'], {cwd: work});
if (!ok(['diff', '--cached', '--quiet'], {cwd: work})) {
    const summary = `${published.length} report(s)` + (dropped.length ? `, ${dropped.length} stale alias(es) removed` : '');
    run(['commit', '-q', '-m', `report: ${wf}${runNum ? ` run ${runNum}` : ''} — ${summary}`], {cwd: work});
    run(['push', '-q', '--force', authUrl, `HEAD:${pagesBranch}`], {cwd: work});
    console.log(`Pushed to ${extRepo}: ${summary}`);
}

// --- Resolve the base URL (custom-domain aware) ---------------------------------
let base = '';
try {
    const gh = execFileSync('gh', ['api', `/repos/${extRepo}/pages`, '--jq', '.html_url'], {
        env: {...process.env, GH_TOKEN: token},
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (/^https?:/.test(gh.trim())) base = gh.trim();
} catch {
    // fall back below
}
if (!base) base = `https://${owner}.github.io/${extName}`;
base = base.replace(/\/+$/, '');

const urls = {};
for (const tool of published) {
    const url = `${base}/${tool}/${wf}/${runNum}/`;
    urls[tool] = url;
    console.log(`Published ${tool} report: ${url}`);
}
for (const alias of dropped) console.log(`Removed stale alias ${alias}`);

setOutput('deployed', 'true');
setOutput('urls', JSON.stringify(urls));

// --- Helpers -------------------------------------------------------------------
function hasBranch(url, branch) {
    try {
        const refs = execFileSync('git', ['ls-remote', '--heads', url, branch], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return refs.trim() !== '';
    } catch {
        return false;
    }
}
function genIndex(dir, title, exclude = new Set()) {
    const subs = readdirSync(dir, {withFileTypes: true})
        .filter((d) => d.isDirectory() && !exclude.has(d.name))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    const rows = subs.map((s) => `<li><a href="${s}/">${s}</a></li>`).join('\n');
    const html =
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>' +
        title +
        '</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>' +
        title +
        '</h1><ul>\n' +
        rows +
        (rows ? '\n' : '') +
        '</ul></body></html>\n';
    writeFileSync(join(dir, 'index.html'), html);
}
