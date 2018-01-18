"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promise_prototype_finally_1 = require("promise.prototype.finally");
promise_prototype_finally_1.shim();
class Work {
    constructor(startWork) {
        this.expirationDelay = () => Math.max(0, this.expirationTime - Date.now());
        this.isExpired = () => this.expirationTime && this.expirationDelay() <= 0;
        this.startWork = startWork;
        this.whenComplete = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        this.expirationTime = 0;
        this.prev = this;
        this.next = this;
    }
    insertAfter(work) {
        this.prev = work;
        this.next = work.next;
        this.prev.next = this;
        this.next.prev = this;
    }
    remove() {
        this.prev.next = this.next;
        this.next.prev = this.prev;
    }
    execute(cleanup) {
        this.expirationTime = Date.now() + 1000;
        try {
            this.startWork()
                .finally(cleanup)
                .then(this.resolve)
                .catch(this.reject);
        }
        catch (e) {
            cleanup();
            this.reject(e);
        }
        finally {
            return this.whenComplete;
        }
    }
}
class AsyncThrottle {
    constructor(options) {
        this.first = () => this.workList.next;
        this.last = () => this.workList.prev;
        this.hasExpiredWork = () => this.first().isExpired();
        this.hasReadyWork = () => this.readyWorkPredecessor.next !== this.workList;
        this.atMaxOutstanding = () => this.outstandingCount >= this.maxOutstanding;
        this.atMaxQps = () => this.qpsCount >= this.maxQps;
        this.canExecuteWork = () => !this.atMaxQps() && !this.atMaxOutstanding();
        this.workList = new Work(() => Promise.resolve());
        this.readyWorkPredecessor = this.workList;
        this.maxOutstanding = options.maxOutstanding || Number.MAX_SAFE_INTEGER;
        this.outstandingCount = 0;
        this.maxQps = options.maxQps || Number.MAX_SAFE_INTEGER;
        this.qpsCount = 0;
        this.expiringWorkTimer = null;
        this.whenQuiescent = null;
        this.onLastWorkItemDrained = null;
    }
    onWorkItemEnqueued() {
        if (!this.whenQuiescent) {
            this.whenQuiescent = new Promise(resolve => {
                this.onLastWorkItemDrained = () => {
                    resolve();
                    this.whenQuiescent = null;
                    this.onLastWorkItemDrained = null;
                };
            });
        }
    }
    // Removes all expired work items from the list and updates tracking counts.
    purgeExpiredWork() {
        while (this.hasExpiredWork()) {
            const work = this.first();
            // ASSERT(work.isExpired());
            work.remove();
            this.qpsCount -= 1;
            // Pointer fixup if necessary.
            if (this.readyWorkPredecessor === work) {
                this.readyWorkPredecessor = work.prev;
                // "Next ready work" remains the same, via this.readyWorkPredecessor.next.
                // ASSERT(work.next === this.readyWorkPredecessor.next);
            }
        }
    }
    // Executes all ready work items until/unless they must be throttled.
    executeReadyWork() {
        while (this.hasReadyWork() && this.canExecuteWork()) {
            const work = this.readyWorkPredecessor.next;
            this.readyWorkPredecessor = work;
            this.outstandingCount += 1;
            this.qpsCount += 1;
            // Execute the work. Also update outstanding counts when the work completes, and trigger new work if necessary.
            work.execute(() => {
                const shouldTriggerWork = this.atMaxOutstanding();
                if (--this.outstandingCount === 0 && !this.hasReadyWork()) {
                    // ASSERT(this.onLastWorkItemDrained);
                    this.onLastWorkItemDrained();
                }
                if (shouldTriggerWork) {
                    this.processWork();
                }
            });
        }
    }
    // Ensure that the timer status correct, given the state of work in the throttle.
    // A timer should be set iff work is waiting due to QPS throttling.
    updateTimer() {
        if (this.hasReadyWork() && this.atMaxQps() && !this.atMaxOutstanding()) {
            if (!this.expiringWorkTimer) {
                // We can't assert !this.hasExpiredWork, since it changes to true with the passage of time.
                this.expiringWorkTimer = global.setTimeout(() => {
                    this.expiringWorkTimer = null;
                    this.processWork();
                }, this.first().expirationDelay());
            }
        }
        else {
            // Cancel the waiting timer, since there's currently nothing to wait for.
            if (this.expiringWorkTimer) {
                global.clearTimeout(this.expiringWorkTimer);
                this.expiringWorkTimer = null;
            }
        }
    }
    // The main processing method for the throttle, which must be called in order for work to be executed. It can be
    // called safely at any time (it's idempotent-ish). This method handles executing all available work, and ensuring
    // that if it must be throttled it will be executed at the next available opportunity.
    processWork() {
        this.purgeExpiredWork();
        this.executeReadyWork();
        this.updateTimer();
    }
    // The main entry point to the throttle. Receives a function that will generate a promise, and executes it according
    // to the throttling policy currently being used. Returns a promise that is immediately available, and will be
    // settled with the value (or error) of the promise generated by the call to startWork.
    callThrottled(startWork) {
        const work = new Work(startWork);
        work.insertAfter(this.last());
        this.onWorkItemEnqueued();
        this.processWork();
        return work.whenComplete;
    }
    whenDrained() {
        return this.whenQuiescent ? this.whenQuiescent : Promise.resolve();
    }
    static callAllThrottled(startWorkArray, options) {
        return new Promise((resolve, reject) => {
            let rejected = false;
            const results = new Array(startWorkArray.length);
            let outstandingResultCount = startWorkArray.length;
            const throttle = new AsyncThrottle(options);
            for (let i = 0; i < startWorkArray.length; i++) {
                throttle
                    .callThrottled(startWorkArray[i])
                    .then(value => {
                    results[i] = value;
                    if (--outstandingResultCount === 0) {
                        // All promises fulfilled, so resolve now.
                        resolve(results);
                    }
                })
                    .catch(error => {
                    if (!rejected) {
                        // This is the first error, so reject now.
                        // Don't decrement the count. Thus the fulfill path will never execute.
                        rejected = true;
                        reject(error);
                    }
                });
            }
        });
    }
}
exports.AsyncThrottle = AsyncThrottle;
