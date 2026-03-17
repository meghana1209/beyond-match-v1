/**
 * BeyondMatch - Button & Interactive Element Audit Script
 * Run with: node test-buttons.js
 * 
 * This script scans all HTML files in the project directory and
 * audits every button, anchor, and clickable element for:
 *   - onclick handlers and their target functions
 *   - href links (internal/external/missing)
 *   - form submit buttons
 *   - Missing/empty handlers
 *   - Accessibility attributes (aria-label, disabled state)
 */

const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────
const PROJECT_DIR = process.argv[2] || '.';
const HTML_FILES = [
  'index.html',
  'admin.html',
  'cand-matches.html',
  'candidate-dashboard.html',
  'jobmatches.html',
  'locatehire.html',
  'login.html',
  'rec-actions.html',
  'rec-dash.html',
  'rec-jobs.html',
  'resume.html',
  'savedjobs.html',
  'settings.html',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function extractTag(html, tagPattern) {
  const results = [];
  const regex = new RegExp(tagPattern, 'gi');
  let match;
  while ((match = regex.exec(html)) !== null) {
    results.push({ raw: match[0], index: match.index });
  }
  return results;
}

function getAttr(tag, attr) {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = tag.match(re);
  return m ? m[1] : null;
}

function getLineNumber(html, index) {
  return html.substring(0, index).split('\n').length;
}

function extractFunctionsFromJS(jsContent) {
  const defined = new Set();
  const patterns = [
    /function\s+(\w+)\s*\(/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?function/g,
    /(\w+)\s*:\s*(?:async\s*)?function/g,
    /(\w+)\s*:\s*(?:async\s*)?\(/g,
    /window\.(\w+)\s*=\s*(?:async\s*)?function/g,
    /window\.(\w+)\s*=\s*(?:async\s*)?\(/g,
    /window\.(\w+)\s*=\s*async\s+\(/g,
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(jsContent)) !== null) {
      defined.add(m[1]);
    }
  }
  return defined;
}

// ─── Collect JS Function Definitions ─────────────────────────────────────────
function collectDefinedFunctions(dir) {
  const defined = new Set();
  const jsFiles = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const file of jsFiles) {
    const content = readFile(path.join(dir, file));
    if (content) {
      const fns = extractFunctionsFromJS(content);
      fns.forEach(fn => defined.add(fn));
    }
  }
  return defined;
}

function collectFunctionsFromHTML(dir) {
  const defined = new Set();
  const htmlFiles = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  for (const file of htmlFiles) {
    const content = readFile(path.join(dir, file));
    if (!content) continue;
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(content)) !== null) {
      const fns = extractFunctionsFromJS(match[1]);
      fns.forEach(fn => defined.add(fn));
    }
  }
  return defined;
}

// ─── Audit a Single File ──────────────────────────────────────────────────────
function auditFile(filePath, definedFunctions) {
  const content = readFile(filePath);
  if (!content) return null;

  const fileName = path.basename(filePath);
  const results = {
    file: fileName,
    total: 0,
    pass: [],
    warn: [],
    fail: [],
  };

  // --- BUTTONS ---
  const buttonTags = extractTag(content, '<button[^>]*>');
  for (const { raw, index } of buttonTags) {
    const line = getLineNumber(content, index);
    const onclick = getAttr(raw, 'onclick');
    const type = getAttr(raw, 'type') || 'submit';
    const disabled = /\bdisabled\b/i.test(raw);
    const ariaLabel = getAttr(raw, 'aria-label');
    const id = getAttr(raw, 'id') || '(no id)';
    const classAttr = getAttr(raw, 'class') || '';

    results.total++;

    const entry = {
      line,
      element: 'BUTTON',
      id,
      class: classAttr.split(' ').slice(0, 2).join(' '),
      type,
      onclick: onclick || null,
      ariaLabel,
      disabled,
    };

    if (disabled) {
      results.warn.push({ ...entry, status: 'DISABLED', note: 'Button is disabled — intentional?' });
    } else if (!onclick && type !== 'submit') {
      results.fail.push({ ...entry, status: 'FAIL', note: 'No onclick handler and not type=submit' });
    } else if (onclick) {
      // Extract function name from onclick
      const fnMatch = onclick.match(/^(\w+)\s*\(/);
      const fnName = fnMatch ? fnMatch[1] : null;
      if (fnName && !definedFunctions.has(fnName)) {
        results.fail.push({ ...entry, status: 'FAIL', note: `onclick calls '${fnName}' — function NOT FOUND in JS files` });
      } else if (fnName) {
        results.pass.push({ ...entry, status: 'PASS', note: `onclick → ${fnName}() ✓` });
      } else {
        results.warn.push({ ...entry, status: 'WARN', note: `onclick expression: "${onclick}" — verify manually` });
      }
    } else {
      results.pass.push({ ...entry, status: 'PASS', note: 'type=submit inside form' });
    }
  }

  // --- ANCHOR TAGS ---
  const anchorTags = extractTag(content, '<a[^>]+>');
  for (const { raw, index } of anchorTags) {
    const line = getLineNumber(content, index);
    const href = getAttr(raw, 'href');
    const onclick = getAttr(raw, 'onclick');
    const id = getAttr(raw, 'id') || '(no id)';
    const classAttr = getAttr(raw, 'class') || '';

    if (!href && !onclick) continue; // Skip non-interactive anchors
    results.total++;

    const entry = {
      line,
      element: 'ANCHOR',
      id,
      class: classAttr.split(' ').slice(0, 2).join(' '),
      href: href || '(none)',
      onclick: onclick || null,
    };

    if (!href || href === '#' || href === 'javascript:void(0)') {
      if (onclick) {
        const fnMatch = onclick.match(/^(\w+)\s*\(/);
        const fnName = fnMatch ? fnMatch[1] : null;
        if (fnName && !definedFunctions.has(fnName)) {
          results.fail.push({ ...entry, status: 'FAIL', note: `href is placeholder; onclick calls '${fnName}' — NOT FOUND` });
        } else {
          results.pass.push({ ...entry, status: 'PASS', note: onclick ? `onclick handler present` : 'placeholder href' });
        }
      } else {
        results.warn.push({ ...entry, status: 'WARN', note: `href="${href}" with no onclick — dead link?` });
      }
    } else if (href.startsWith('http')) {
      results.pass.push({ ...entry, status: 'PASS', note: `External link → ${href}` });
    } else if (href.endsWith('.html')) {
      const targetExists = fs.existsSync(path.join(PROJECT_DIR, href));
      if (targetExists) {
        results.pass.push({ ...entry, status: 'PASS', note: `Internal link → ${href} ✓` });
      } else {
        results.fail.push({ ...entry, status: 'FAIL', note: `Internal link → ${href} — FILE NOT FOUND` });
      }
    } else {
      results.pass.push({ ...entry, status: 'PASS', note: `href="${href}"` });
    }
  }

  // --- INPUT TYPE=SUBMIT / TYPE=BUTTON ---
  const inputBtns = extractTag(content, '<input[^>]+type\\s*=\\s*["\'](submit|button|reset)["\'][^>]*>');
  for (const { raw, index } of inputBtns) {
    const line = getLineNumber(content, index);
    const type = getAttr(raw, 'type');
    const value = getAttr(raw, 'value') || '(no value)';
    const onclick = getAttr(raw, 'onclick');
    const disabled = /\bdisabled\b/i.test(raw);

    results.total++;
    const entry = { line, element: `INPUT[${type}]`, value, onclick };

    if (disabled) {
      results.warn.push({ ...entry, status: 'DISABLED', note: 'Input button is disabled' });
    } else if (type === 'submit') {
      results.pass.push({ ...entry, status: 'PASS', note: 'Submit input — triggers form submission' });
    } else if (onclick) {
      results.pass.push({ ...entry, status: 'PASS', note: `onclick="${onclick}"` });
    } else {
      results.warn.push({ ...entry, status: 'WARN', note: 'type=button/reset with no handler' });
    }
  }

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  console.log('='.repeat(70));
  console.log('  BeyondMatch — Button & Interactive Element Audit');
  console.log(`  Project: ${path.resolve(PROJECT_DIR)}`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log('='.repeat(70));
const definedFunctions = collectDefinedFunctions(PROJECT_DIR);
const htmlFunctions    = collectFunctionsFromHTML(PROJECT_DIR);
htmlFunctions.forEach(fn => definedFunctions.add(fn));
console.log(`\n✓ Found ${definedFunctions.size} JS functions: ...`);
  const summary = {
    totalFiles: 0,
    totalElements: 0,
    totalPass: 0,
    totalWarn: 0,
    totalFail: 0,
    fileResults: [],
  };

  for (const htmlFile of HTML_FILES) {
    const filePath = path.join(PROJECT_DIR, htmlFile);
    const result = auditFile(filePath, definedFunctions);
    if (!result) {
      console.log(`\n[SKIP] ${htmlFile} — not found`);
      continue;
    }

    summary.totalFiles++;
    summary.totalElements += result.total;
    summary.totalPass += result.pass.length;
    summary.totalWarn += result.warn.length;
    summary.totalFail += result.fail.length;
    summary.fileResults.push(result);

    const status = result.fail.length > 0 ? '✗ ISSUES' : result.warn.length > 0 ? '⚠ WARNINGS' : '✓ OK';
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${status}  ${htmlFile}  (${result.total} elements)`);
    console.log(`${'─'.repeat(60)}`);

    if (result.pass.length) {
      console.log(`  PASS (${result.pass.length}):`);
      result.pass.forEach(e => console.log(`    L${e.line} [${e.element}] ${e.note}`));
    }
    if (result.warn.length) {
      console.log(`  WARN (${result.warn.length}):`);
      result.warn.forEach(e => console.log(`    ⚠ L${e.line} [${e.element}] ${e.note}`));
    }
    if (result.fail.length) {
      console.log(`  FAIL (${result.fail.length}):`);
      result.fail.forEach(e => console.log(`    ✗ L${e.line} [${e.element}] ${e.note}`));
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('  AUDIT SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Files Scanned  : ${summary.totalFiles}`);
  console.log(`  Total Elements : ${summary.totalElements}`);
  console.log(`  ✓ Pass         : ${summary.totalPass}`);
  console.log(`  ⚠ Warnings     : ${summary.totalWarn}`);
  console.log(`  ✗ Failures     : ${summary.totalFail}`);
  const score = summary.totalElements > 0
    ? Math.round((summary.totalPass / summary.totalElements) * 100)
    : 0;
  console.log(`  Health Score   : ${score}%`);
  console.log('='.repeat(70));

  // Write JSON for report generation
  const outPath = path.join(PROJECT_DIR, 'audit_results.json');
  fs.writeFileSync(outPath, JSON.stringify({ summary, definedFunctionsCount: definedFunctions.size }, null, 2));
  console.log(`\n✓ Results saved to ${outPath}`);
}

main();