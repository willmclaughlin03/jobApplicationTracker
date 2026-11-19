'use strict';
/* global describe, it, expect, __dirname */

/** Parse the manual-only workflow at its published location; never call GitHub or a shell. */
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const tool = require('../qualify-static.cjs');
const text = fs.readFileSync(tool.workflowPath(path.resolve(__dirname, '..')), 'utf8');
const workflow = YAML.parse(text), job = workflow.jobs.static;

describe('workflow execution and retention boundary', () => {
  it('has only a manual event and the four required approval inputs', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual(['execution_digest', 'package_digest', 'run_number', 'workflow_sha']);
    for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) expect(input).toMatchObject({ required: true, type: 'string' });
  });
  it('requires the immutable revision, main, one run number and first attempt', () => {
    for (const guard of ["github.event_name == 'workflow_dispatch'", "github.ref == 'refs/heads/main'", 'github.run_attempt == 1', 'github.run_number == fromJSON(inputs.run_number)', 'github.workflow_sha == inputs.workflow_sha']) expect(job.if).toContain(guard);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false); expect(workflow.permissions).toEqual({ contents: 'read' });
  });
  it('separates fixed application source from workflow tools with no persisted credentials', () => {
    const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(2); expect(checkouts[0].with.ref).toBe('${{ github.workflow_sha }}'); expect(checkouts[1].with.ref).toBe(tool.SOURCE);
    expect(checkouts.map(step => step.with.path)).toEqual(['tooling', 'application']);
    for (const step of checkouts) expect(step.with['persist-credentials']).toBe(false);
  });
  it('pins actions and Node without a dependency cache', () => {
    for (const step of job.steps.filter(step => step.uses)) expect(step.uses).toMatch(/^actions\/[a-z-]+@[a-f0-9]{40}$/);
    const setup = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
    expect(setup.with['node-version']).toBe('22.23.3'); expect(setup.with['package-manager-cache']).toBe(false); expect(setup.with).not.toHaveProperty('cache');
    expect(job['runs-on']).toBe('ubuntu-24.04'); expect(job['timeout-minutes']).toBe(30);
    for (const step of job.steps) expect(step['timeout-minutes']).toBeGreaterThan(0);
  });
  it('has only the reviewed static runner and upload-validation shell commands', () => {
    expect(job.steps.filter(step => step.run).map(step => step.run)).toEqual([
      'node tooling/scripts/gate1-ci-tools/main-8c68fd9e-static-attempt-1/qualify-static.cjs --run',
      'node tooling/scripts/gate1-ci-tools/main-8c68fd9e-static-attempt-1/qualify-static.cjs --validate-upload',
    ]);
    expect(text).not.toMatch(/secrets\.|npm start|curl |wget |next start|workflow_call|pull_request/);
    for (const step of job.steps.filter(step => step.run)) expect(step.run).not.toContain('${{');
  });
  it('uploads only the prevalidated report with finite retention and no overwrite', () => {
    const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload.if).toContain("steps.validate.outcome == 'success'");
    expect(upload.with).toMatchObject({ path: 'gate1-static-evidence/report.json', 'retention-days': 7, 'if-no-files-found': 'error', overwrite: false, 'include-hidden-files': false, 'compression-level': 0 });
    expect(upload['timeout-minutes']).toBe(2);
  });
  it('keeps native runtime and HTTP helpers out of the static inspector', () => {
    const source = fs.readFileSync(path.join(__dirname, '../inspect-compiled.cjs'), 'utf8');
    expect(source).not.toMatch(/node:http|node:https|observeNativeReads|getLocal|reviewResponse|\.listen\(/);
  });
});
