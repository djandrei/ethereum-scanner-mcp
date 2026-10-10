/**
 * In-memory registry of scan jobs. Jobs are lost when the process exits.
 */

import type { ScanJob } from './scan-job.js';

export interface JobStoreLimits
{
    maxConcurrentScans: number;
    maxFinishedJobs: number;
}

export class JobStore
{
    private readonly maxConcurrentScans: number;
    private readonly maxFinishedJobs: number;
    private readonly jobs = new Map<string, ScanJob>();
    private sequence = 0;

    constructor({ maxConcurrentScans, maxFinishedJobs }: JobStoreLimits)
    {
        this.maxConcurrentScans = maxConcurrentScans;
        this.maxFinishedJobs = maxFinishedJobs;
    }

    runningCount(): number
    {
        let count = 0;
        for (const job of this.jobs.values())
        {
            if (!job.isFinished())
            {
                count++;
            }
        }
        return count;
    }

    canStart(): boolean
    {
        return this.runningCount() < this.maxConcurrentScans;
    }

    add(job: ScanJob): void
    {
        // Insertion order, not the millisecond timestamp: jobs started in the
        // same millisecond must still order and evict deterministically.
        job.sequence = ++this.sequence;
        this.jobs.set(job.jobId, job);
        this.evictFinished();
    }

    get(jobId: string): ScanJob | null
    {
        return this.jobs.get(jobId) ?? null;
    }

    /** Most recent first. */
    list(): ScanJob[]
    {
        return Array.from(this.jobs.values()).sort((a, b) => b.sequence - a.sequence);
    }

    evictFinished(): void
    {
        const finished = this.list().filter(job => job.isFinished());
        for (const job of finished.slice(this.maxFinishedJobs))
        {
            this.jobs.delete(job.jobId);
        }
    }
}
