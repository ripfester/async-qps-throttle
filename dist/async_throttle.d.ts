export interface AsyncThrottleOptions {
    maxOutstanding?: number;
    maxQps?: number;
}
export declare class AsyncThrottle {
    private readonly workList;
    private readonly first;
    private readonly last;
    private readonly hasExpiredWork;
    private readyWorkPredecessor;
    private readonly hasReadyWork;
    private readonly maxOutstanding;
    private outstandingCount;
    private readonly atMaxOutstanding;
    private readonly maxQps;
    private qpsCount;
    private readonly atMaxQps;
    private readonly canExecuteWork;
    private expiringWorkTimer;
    private whenQuiescent;
    private onLastWorkItemDrained;
    private onWorkItemEnqueued();
    constructor(options: AsyncThrottleOptions);
    private purgeExpiredWork();
    private executeReadyWork();
    private updateTimer();
    private processWork();
    callThrottled<T>(startWork: () => Promise<T>): Promise<T>;
    whenDrained(): Promise<void>;
    static callAllThrottled<T>(startWorkArray: Array<() => Promise<T>>, options: AsyncThrottleOptions): Promise<T[]>;
}
