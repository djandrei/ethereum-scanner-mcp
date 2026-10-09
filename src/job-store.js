/**
 * In-memory registry of scan jobs. Jobs are lost when the process exits.
 */

export class JobStore
{
    constructor({ maxConcurrentScans, maxFinishedJobs })
    {
        this.maxConcurrentScans = maxConcurrentScans;
        this.maxFinishedJobs = maxFinishedJobs;
        this.jobs = new Map();
        this.sequence = 0;
    }

    runningCount()
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

    canStart()
    {
        return this.runningCount() < this.maxConcurrentScans;
    }

    add(job)
    {
        // Insertion order, not the millisecond timestamp: jobs started in the
        // same millisecond must still order and evict deterministically.
        job.sequence = ++this.sequence;
        this.jobs.set(job.jobId, job);
        this.evictFinished();
    }

    get(jobId)
    {
        return this.jobs.get(jobId) || null;
    }

    /** Most recent first. */
    list()
    {
        return Array.from(this.jobs.values()).sort((a, b) => b.sequence - a.sequence);
    }

    evictFinished()
    {
        const finished = this.list().filter(job => job.isFinished());
        for (const job of finished.slice(this.maxFinishedJobs))
        {
            this.jobs.delete(job.jobId);
        }
    }
}
