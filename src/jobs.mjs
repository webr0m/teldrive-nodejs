import { id, now, expires, expired, number, fail, page } from "./core.mjs";

const states = [
  "pending",
  "scheduled",
  "available",
  "running",
  "retryable",
  "cancelled",
  "discarded",
  "completed",
];
const active = ["pending", "scheduled", "available", "running", "retryable"];
const types = ["teldrive_upload_cleanup", "teldrive_pending_file_purge"];

export class Jobs {
  constructor(store, uploads, config) {
    Object.assign(this, { store, uploads, config });
    this.workerId = id();
  }
  public(job) {
    const { ownerId, workerId, leaseExpiresAt, ...body } = job;
    return body;
  }
  get(userId, jobId) {
    const job = this.store.get("jobs", jobId);
    if (!job || job.ownerId !== String(userId)) fail(404, "job_not_found");
    return job;
  }
  list(userId, query) {
    const status = query.get("status");
    if (status && !states.includes(status)) fail(422, "invalid_job_state");
    const jobs = this.store
      .list("jobs", String(userId))
      .filter(
        (j) =>
          (!status || j.status === status) &&
          (!query.has("type") || j.type === query.get("type")) &&
          (!query.has("queue") || j.queue === query.get("queue")),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const result = page(
      jobs.map((j) => this.public(j)),
      query,
    );
    return { tasks: result.items, meta: { nextCursor: result.nextCursor } };
  }
  statistics(userId) {
    const counts = Object.fromEntries(states.map((s) => [s, 0]));
    for (const job of this.store.list("jobs", String(userId))) counts[job.status]++;
    return counts;
  }
  queues(userId) {
    const queues = new Map([
      [
        "maintenance",
        {
          name: "maintenance",
          paused: false,
          available: 0,
          running: 0,
          retryable: 0,
          scheduled: 0,
        },
      ],
    ]);
    for (const job of this.store.list("jobs", String(userId))) {
      if (!queues.has(job.queue))
        queues.set(job.queue, {
          name: job.queue,
          paused: false,
          available: 0,
          running: 0,
          retryable: 0,
          scheduled: 0,
        });
      const q = queues.get(job.queue);
      if (job.status in q) q[job.status]++;
    }
    for (const q of queues.values())
      q.paused = !!this.store.get("job-queues", `${userId}:${q.name}`)?.paused;
    return { queues: [...queues.values()] };
  }
  pause(userId, queue, paused) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(queue)) fail(422, "invalid_queue");
    this.store.put("job-queues", { id: `${userId}:${queue}`, ownerId: String(userId), paused });
  }
  create(userId, body) {
    if (!types.includes(body.type)) fail(422, "unsupported_job_type");
    const batchSize = number(body.args?.batchSize ?? 100, 1, this.config.jobBatchLimit ?? 1000);
    const queue = body.queue || "maintenance";
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(queue)) fail(422, "invalid_queue");
    const priority = number(body.priority ?? 2, 1, 4),
      maxAttempts = number(body.maxAttempts ?? 10, 1, 100);
    const tags = body.tags ?? [];
    if (
      !Array.isArray(tags) ||
      tags.length > 20 ||
      tags.some((t) => typeof t !== "string" || t.length > 64)
    )
      fail(422, "invalid_job_tags");
    const job = {
      id: id(),
      ownerId: String(userId),
      type: body.type,
      args: { batchSize },
      queue,
      priority,
      maxAttempts,
      tags,
      status: "available",
      attempt: 0,
      errors: [],
      attemptedBy: [],
      createdAt: now(),
      scheduledAt: now(),
    };
    this.store.put("jobs", job);
    this.wake();
    return this.public(job);
  }
  cancel(userId, jobId) {
    const job = this.get(userId, jobId);
    if (!active.includes(job.status)) fail(409, "job_not_active");
    job.status = "cancelled";
    job.completedAt = now();
    delete job.workerId;
    delete job.leaseExpiresAt;
    this.store.put("jobs", job);
    return this.public(job);
  }
  retry(userId, jobId) {
    const job = this.get(userId, jobId);
    if (!["cancelled", "discarded", "retryable"].includes(job.status))
      fail(409, "job_not_retryable");
    job.status = "available";
    job.scheduledAt = now();
    job.maxAttempts = Math.max(job.maxAttempts, job.attempt + 1);
    delete job.completedAt;
    delete job.workerId;
    delete job.leaseExpiresAt;
    this.store.put("jobs", job);
    this.wake();
    return this.public(job);
  }
  delete(userId, jobId) {
    const job = this.get(userId, jobId);
    if (active.includes(job.status)) fail(409, "cancel_job_first");
    this.store.delete("jobs", job.id);
  }
  purge(userId, status) {
    if (!["completed", "retryable", "discarded"].includes(status)) fail(422, "invalid_job_state");
    const jobs = this.store.list("jobs", String(userId)).filter((j) => j.status === status);
    this.store.transaction(() => {
      for (const job of jobs) this.store.delete("jobs", job.id);
    });
    return { count: jobs.length };
  }
  wake() {
    if (!this.closed && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.run().catch(() => {});
      }, 0).unref();
  }
  start() {
    this.nextPoll = 0;
    this.poll = setInterval(() => {
      if (Date.now() >= this.nextPoll) {
        this.nextPoll = Date.now() + (this.config.jobPollSeconds ?? 10) * 1000;
        this.wake();
      }
    }, 1000).unref();
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    await this.running;
  }
  async run() {
    if (this.running || this.closed) return;
    this.running = this.work();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  async work() {
    // Claim one bounded batch per turn. The database lease prevents two Passenger processes running it.
    const candidates = this.store
      .list("jobs")
      .filter(
        (j) =>
          ["available", "retryable", "scheduled", "pending"].includes(j.status) ||
          (j.status === "running" && expired(j.leaseExpiresAt)),
      )
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    for (const candidate of candidates) {
      if (this.closed) break;
      if (this.store.get("users", candidate.ownerId)?.disabled) continue;
      if (
        Date.parse(candidate.scheduledAt) > Date.now() ||
        this.store.get("job-queues", `${candidate.ownerId}:${candidate.queue}`)?.paused
      )
        continue;
      const job = this.store.claimJob(
        candidate.id,
        this.workerId,
        this.config.jobLeaseSeconds ?? 300,
      );
      if (!job) continue;
      let leaseLost = false;
      const heartbeat = setInterval(
        () => {
          try {
            if (!this.store.claimJob(job.id, this.workerId, this.config.jobLeaseSeconds ?? 300))
              leaseLost = true;
          } catch {
            leaseLost = true;
          }
        },
        Math.max(10000, ((this.config.jobLeaseSeconds ?? 300) * 1000) / 3),
      ).unref();
      try {
        let processed = 0;
        const records =
          job.type === "teldrive_upload_cleanup"
            ? this.store
                .list("uploads", job.ownerId)
                .filter((u) => !["completed", "aborted"].includes(u.state) && expired(u.expiresAt))
            : this.uploads.catalog
                .all(job.ownerId)
                .filter(
                  (f) =>
                    f.status === "deletion_pending" &&
                    (f.deleteAfter
                      ? expired(f.deleteAfter)
                      : Date.parse(f.updatedAt) <=
                        Date.now() - (this.config.pendingRetentionDays ?? 30) * 86400_000),
                );
        for (const record of records.slice(0, job.args.batchSize)) {
          const current = this.get(job.ownerId, job.id);
          if (leaseLost || current.status !== "running" || current.workerId !== this.workerId)
            break;
          if (!this.store.claimJob(job.id, this.workerId, this.config.jobLeaseSeconds ?? 300))
            break;
          if (job.type === "teldrive_pending_file_purge" && !this.store.get("files", record.id)) {
            processed++;
            continue;
          }
          if (job.type === "teldrive_upload_cleanup")
            await this.uploads.abort(job.ownerId, record.id);
          else await this.uploads.purge(job.ownerId, record.id);
          processed++;
        }
        const current = this.get(job.ownerId, job.id);
        if (!leaseLost && current.status === "running" && current.workerId === this.workerId) {
          current.status = "completed";
          current.completedAt = now();
          current.output = { processed, remaining: Math.max(0, records.length - processed) };
          delete current.workerId;
          delete current.leaseExpiresAt;
          this.store.put("jobs", current);
        }
      } catch (error) {
        const current = this.get(job.ownerId, job.id);
        if (current.status !== "running" || current.workerId !== this.workerId) continue;
        current.errors.push({
          attempt: current.attempt,
          at: now(),
          error: error.code || "job_failed",
        });
        current.message = error.code || "job_failed";
        current.status = current.attempt >= current.maxAttempts ? "discarded" : "retryable";
        current.scheduledAt = expires(Math.min(300, 2 ** Math.min(current.attempt, 8)) * 1000);
        delete current.workerId;
        delete current.leaseExpiresAt;
        this.store.put("jobs", current);
      } finally {
        clearInterval(heartbeat);
      }
      break;
    }
  }
}
