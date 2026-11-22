'use strict';
/* global describe, it, expect */

/** Parse the workflow as data; these checks never access Actions or execute its shell commands. */
const fs = require('node:fs');
const YAML = require('yaml');
const tool = require('../qualify-runtime.cjs');
const text = fs.readFileSync(tool.workflowPath(), 'utf8'), workflow = YAML.parse(text), job = workflow.jobs.runtime;

describe('manual workflow and report-only retention', () => {
  it('has only the manual trigger, four required approval inputs and read-only repository permission', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']); expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual(['execution_digest', 'package_digest', 'run_number', 'workflow_sha']);
    for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) expect(input).toMatchObject({ type: 'string', required: true });
  });
  it('restricts repository, main, workflow revision, run number and first attempt', () => {
    for (const guard of ["github.event_name == 'workflow_dispatch'", "github.ref == 'refs/heads/main'", "github.repository == 'willmclaughlin03/jobApplicationTracker'",
      'github.run_attempt == 1', 'github.run_number == fromJSON(inputs.run_number)', 'github.workflow_sha == inputs.workflow_sha']) expect(job.if).toContain(guard);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });
  it('checks out immutable tooling and the pinned application without persisted credentials', () => {
    const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkouts.map(step => [step.with.ref, step.with.path])).toEqual([['${{ github.workflow_sha }}', 'tooling'], [tool.SOURCE, 'application'], ['${{ github.workflow_sha }}', 'validation-tooling']]);
    for (const step of checkouts) expect(step.with['persist-credentials']).toBe(false);
  });
  it('pins every action, exact Node, runner and finite timeouts without dependency caching', () => {
    for (const step of job.steps.filter(step => step.uses)) expect(step.uses).toMatch(/^actions\/[a-z-]+@[a-f0-9]{40}$/);
    const setup = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
    expect(setup.with).toEqual({ 'node-version': '22.23.3', 'package-manager-cache': false });
    expect(job['runs-on']).toBe('ubuntu-24.04'); expect(job['timeout-minutes']).toBe(30);
    for (const step of job.steps) expect(step['timeout-minutes']).toBeGreaterThan(0);
  });
  it('has only fixed guarded runner and validation commands, never interpolated user input', () => {
    expect(job.steps.filter(step => step.run).map(step => step.run)).toEqual([
      'node tooling/scripts/gate1-ci-tools/main-8c68fd9e-runtime-attempt-1/qualify-runtime.cjs --run',
      'node validation-tooling/scripts/gate1-ci-tools/main-8c68fd9e-runtime-attempt-1/qualify-runtime.cjs --validate-upload',
    ]);
    expect(text).not.toMatch(/secrets\.|curl |wget |npm start|next start|workflow_call|pull_request/);
    for (const step of job.steps.filter(step => step.run)) expect(step.run).not.toContain('${{');
  });
  it('validates failed-run reports too, and uploads only the validated report for seven days', () => {
    const validate = job.steps.find(step => step.id === 'validate'), upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    const tools = job.steps.find(step => step.id === 'validation_tools');
    expect(tools.if).toContain("always() && steps.qualify.outputs.reportSha256 != ''");
    expect(validate.if).toContain("steps.validation_tools.outcome == 'success'");
    expect(validate.env).toEqual({ GATE1_REPORT_SHA256: '${{ steps.qualify.outputs.reportSha256 }}' });
    expect(validate.if).toContain('always()'); expect(upload.if).toContain("steps.validate.outcome == 'success'");
    expect(upload.with).toMatchObject({ path: 'gate1-runtime-upload/report.json', 'retention-days': 7, overwrite: false, 'include-hidden-files': false,
      'compression-level': 0, 'if-no-files-found': 'error' });
    expect(upload.with.name).toContain('${{ github.run_id }}-${{ github.run_attempt }}');
  });
});
