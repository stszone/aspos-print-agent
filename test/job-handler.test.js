import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { JobBuffer } from '../src/buffer.js';
import { PrintHistory } from '../src/history.js';
import { createJobHandler } from '../src/job-handler.js';

let dir; let buffer; let history;
const job = (id, kind = 'kot') => ({ job_id: id, kind, driver: 'network_escpos', store_id: 1 });

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobh-test-'));
    buffer = await JobBuffer.create(path.join(dir, 'buf.db'));
    history = await PrintHistory.create(path.join(dir, 'hist.db'));
});
afterEach(() => { buffer.close(); history.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function make(printOk = true) {
    const processJob = jest.fn(async () => printOk);
    const reportResult = jest.fn(async () => {});
    return { processJob, reportResult, jobs: createJobHandler({ buffer, history, processJob, reportResult }) };
}

describe('idempotent re-delivery', () => {
    test('a job re-sent after it printed is NOT printed again but IS re-reported ok', async () => {
        const { jobs, processJob, reportResult } = make();
        await jobs.handle(job('j1'));
        expect(processJob).toHaveBeenCalledTimes(1);

        await jobs.handle(job('j1'));
        expect(processJob).toHaveBeenCalledTimes(1);
        expect(reportResult).toHaveBeenCalledWith('j1', 'ok');
        expect(buffer.activeCount()).toBe(0);
    });

    test('works for receipts already in print_history (older agent data) too', async () => {
        history.record(job('r1', 'receipt'));
        const { jobs, processJob, reportResult } = make();
        await jobs.handle(job('r1', 'receipt'));
        expect(processJob).not.toHaveBeenCalled();
        expect(reportResult).toHaveBeenCalledWith('r1', 'ok');
    });

    test('the printed record survives an agent restart (reopened DB)', async () => {
        const { jobs } = make();
        await jobs.handle(job('j2'));
        history.close();
        history = await PrintHistory.create(path.join(dir, 'hist.db'));
        const again = make();
        await again.jobs.handle(job('j2'));
        expect(again.processJob).not.toHaveBeenCalled();
    });

    test('a failed print is not marked printed, so a re-delivery prints it', async () => {
        const failing = make(false);
        await failing.jobs.handle(job('j3'));
        const ok = make(true);
        await ok.jobs.handle(job('j3'));
        expect(ok.processJob).toHaveBeenCalledTimes(1);
    });

    test('forced local reprint of an already printed job still prints', async () => {
        const { jobs, processJob } = make();
        await jobs.handle(job('j4', 'receipt'));
        await jobs.handle(job('j4', 'receipt'), { force: true });
        expect(processJob).toHaveBeenCalledTimes(2);
    });
});

describe('isBusy (used by the self-updater)', () => {
    test('true while buffered jobs wait, false when idle', async () => {
        const { jobs } = make(false);
        expect(jobs.isBusy()).toBe(false);
        await jobs.handle(job('jb'));
        expect(jobs.isBusy()).toBe(true);
    });

    test('true while a job is printing', async () => {
        let release;
        const gate = new Promise(r => { release = r; });
        const processJob = jest.fn(() => gate.then(() => true));
        const jobs = createJobHandler({ buffer, history, processJob, reportResult: jest.fn() });
        const p = jobs.handle(job('jc'));
        expect(jobs.isBusy()).toBe(true);
        release();
        await p;
        expect(jobs.isBusy()).toBe(false);
    });
});
