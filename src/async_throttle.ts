import {shim} from 'promise.prototype.finally';
shim();

// Options to control throttling.
export interface AsyncThrottleOptions {
  // Throttle work by limiting the number of work items that are started but not yet complete.
  maxOutstanding?: number;
  // Throttle work by limiting the number of work items that can be started within a second (rolling window).
  maxQps?: number;
}

class Work<T> {
  // The function that starts the asynchronous work and generates a promise.
  private readonly startWork: () => Promise<T>;

  // The immediately-available promise which will be settled when the work promise settles.
  readonly whenComplete: Promise<T>;
  private resolve: (value: T) => void;
  private reject: (error: any) => void;

  // The time at which this work expires. Expiration applies to QPS windowing, so work expires 1s after it is started.
  private expirationTime: number;
  readonly expirationDelay = () => Math.max(0, this.expirationTime - Date.now());
  readonly isExpired = () => this.expirationTime && this.expirationDelay() <= 0;

  // Doubly-liked list linkage.
  prev: Work<any>;
  next: Work<any>;

  constructor(startWork: () => Promise<T>) {
    this.startWork = startWork;
    this.whenComplete = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.expirationTime = 0;
    this.prev = this;
    this.next = this;
  }

  insertAfter(work: Work<any>) {
    this.prev = work;
    this.next = work.next;
    this.prev.next = this;
    this.next.prev = this;
  }

  remove() {
    this.prev.next = this.next;
    this.next.prev = this.prev;
  }

  execute(cleanup: () => void) {
    this.expirationTime = Date.now() + 1000;
    try {
      this.startWork()
        .finally(cleanup)
        .then(this.resolve)
        .catch(this.reject)
    } catch (e) {
      cleanup();
      this.reject(e);
    } finally {
      return this.whenComplete;
    }
  }
}

export class AsyncThrottle {
  // The list of work that must be tracked by the throttle. The list includes work that has been executed less than one
  // second ago (even if it is complete) as well as work that has not been started due to being throttled.
  // NB: This is a circular doubly-linked list. This means the last item points to workList, and an empty list consists
  // of workList pointing to itself in both directions.
  private readonly workList: Work<void>;
  private readonly first = () => this.workList.next;
  private readonly last = () => this.workList.prev;
  private readonly hasExpiredWork = () => this.first().isExpired();
  // Within the above list, the predecessor of the oldest work item that has not yet been executed. If the throttle is
  // empty or all tracked work has been executed, readyWorkPredecessor.next will point to workList.
  private readyWorkPredecessor: Work<any>;
  private readonly hasReadyWork = () => this.readyWorkPredecessor.next !== this.workList;

  // Throttle parameters.
  private readonly maxOutstanding: number;
  private outstandingCount: number;
  private readonly atMaxOutstanding = () => this.outstandingCount >= this.maxOutstanding;
  private readonly maxQps: number;
  private qpsCount: number;
  private readonly atMaxQps = () => this.qpsCount >= this.maxQps;
  private readonly canExecuteWork = () => !this.atMaxQps() && !this.atMaxOutstanding();
  // The timer that will trigger when the oldest executed work item becomes one second old. This timer will only be set
  // when throttling because of on QPS (i.e., atMaxQps === true).
  private expiringWorkTimer: NodeJS.Timer | null;

  // A promise that is fulfilled when there is no more outstanding work. This promise exists as long as there is some
  // work that was tracked by the throttle that has not yet completed, but is set to null once the throttle is in a
  // quiescent state.
  private whenQuiescent: Promise<void> | null;
  private onLastWorkItemDrained: (() => void) | null;
  private onWorkItemEnqueued() {
    if (!this.whenQuiescent) {
      this.whenQuiescent = new Promise<void>(resolve => {
        this.onLastWorkItemDrained = () => {
          resolve();
          this.whenQuiescent = null;
          this.onLastWorkItemDrained = null;
        };
      });
    }
  }

  constructor(options: AsyncThrottleOptions) {
    this.workList = new Work<void>(() => Promise.resolve());
    this.readyWorkPredecessor = this.workList;

    this.maxOutstanding = options.maxOutstanding || Number.MAX_SAFE_INTEGER;
    this.outstandingCount = 0;
    this.maxQps = options.maxQps || Number.MAX_SAFE_INTEGER;
    this.qpsCount = 0;
    this.expiringWorkTimer = null;

    this.whenQuiescent = null;
    this.onLastWorkItemDrained = null;
  }

  // Removes all expired work items from the list and updates tracking counts.
  private purgeExpiredWork() {
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
  private executeReadyWork() {
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
          this.onLastWorkItemDrained!();
        }
        if (shouldTriggerWork) {
          this.processWork();
        }
      });
    }
  }

  // Ensure that the timer status correct, given the state of work in the throttle.
  // A timer should be set iff work is waiting due to QPS throttling.
  private updateTimer() {
    if (this.hasReadyWork() && this.atMaxQps() && !this.atMaxOutstanding()) {
      if (!this.expiringWorkTimer) {
        // We can't assert !this.hasExpiredWork, since it changes to true with the passage of time.
        this.expiringWorkTimer = global.setTimeout(() => {
          this.expiringWorkTimer = null;
          this.processWork();
        }, this.first().expirationDelay());
      }
    } else {
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
  private processWork() {
    this.purgeExpiredWork();
    this.executeReadyWork();
    this.updateTimer();
  }

  // The main entry point to the throttle. Receives a function that will generate a promise, and executes it according
  // to the throttling policy currently being used. Returns a promise that is immediately available, and will be
  // settled with the value (or error) of the promise generated by the call to startWork.
  callThrottled<T>(startWork: () => Promise<T>): Promise<T> {
    const work = new Work<T>(startWork);
    work.insertAfter(this.last());
    this.onWorkItemEnqueued();
    this.processWork();
    return work.whenComplete;
  }

  whenDrained(): Promise<void> {
    return this.whenQuiescent ? this.whenQuiescent : Promise.resolve();
  }

  static callAllThrottled<T>(startWorkArray: Array<() => Promise<T>>, options: AsyncThrottleOptions): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      let rejected = false;
      const results = new Array<T>(startWorkArray.length);
      let outstandingResultCount: number = startWorkArray.length;
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
