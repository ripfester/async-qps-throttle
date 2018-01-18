import {AsyncThrottle, AsyncThrottleOptions} from '../src/async_throttle';
import {expect} from 'chai';
import * as lolex from 'lolex';

enum Flags {
  AUTOMATIC = 0x00,
  MANUAL = 0x01,
  ERROR = 0x02,
  FAIL = 0x04,
}

class Worker {
  static functionError = new Error('Work function failed intentionally.');
  static promiseError = new Error('Work promise failed intentionally.');

  called = false;
  complete = () => {};

  flags: number;

  constructor(flags: number = Flags.AUTOMATIC) {
    this.flags = flags;
  }

  work(): Promise<void> {
    this.called = true;

    if (this.flags & Flags.ERROR) {
      throw Worker.functionError;
    }

    if (this.flags & Flags.MANUAL) {
      return new Promise<void>((resolve, reject) => {
        this.complete = () => {
          this.complete = () => {};
          if (this.flags & Flags.FAIL) {
            reject(Worker.promiseError);
          } else {
            resolve();
          }
        };
      });
    }

    if (this.flags & Flags.FAIL) {
      return Promise.reject(Worker.promiseError);
    } else {
      return Promise.resolve();
    }
  }
}

describe('AsyncThrottle', () => {
  let clock;

  beforeEach(() => {
    clock = lolex.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('throttling on outstanding work', () => {
    it('does not throttle with default value', () => {
      const throttle = new AsyncThrottle({});

      for (let i = 0; i < 100; i++) {
        const w = new Worker(Flags.MANUAL);
        expect(w.called).to.be.false;
        throttle.callThrottled(() => w.work());
        expect(w.called).to.be.true;
      }
    });

    it('throttles a sequence of items', () => {
      const throttle = new AsyncThrottle({maxOutstanding: 1});

      const w1 = new Worker(Flags.MANUAL);
      expect(w1.called).to.be.false;
      const w1Complete = throttle.callThrottled(() => w1.work());
      expect(w1.called).to.be.true;

      const w2 = new Worker(Flags.MANUAL);
      expect(w2.called).to.be.false;
      const w2Complete = throttle.callThrottled(() => w2.work());
      expect(w2.called).to.be.false;

      const w3 = new Worker();
      expect(w3.called).to.be.false;
      const w3Complete = throttle.callThrottled(() => w3.work());
      expect(w3.called).to.be.false;

      clock.tick(2000);
      expect(w2.called).to.be.false;
      expect(w3.called).to.be.false;

      w1.complete();

      return w1Complete.then(() => {
        expect(w2.called).to.be.true;
        expect(w3.called).to.be.false;

        w2.complete();

        return w2Complete.then(() => {
          expect(w3.called).to.be.true;
          return Promise.all([w3Complete, throttle.whenDrained()]);
        });
      });
    });

    it('handles out of order completion', () => {
      const throttle = new AsyncThrottle({maxOutstanding: 2});

      const w1 = new Worker(Flags.MANUAL);
      expect(w1.called).to.be.false;
      const w1Complete = throttle.callThrottled(() => w1.work());
      expect(w1.called).to.be.true;

      const w2 = new Worker(Flags.MANUAL);
      expect(w2.called).to.be.false;
      const w2Complete = throttle.callThrottled(() => w2.work());
      expect(w2.called).to.be.true;

      const w3 = new Worker(Flags.MANUAL);
      expect(w3.called).to.be.false;
      const w3Complete = throttle.callThrottled(() => w3.work());
      expect(w3.called).to.be.false;

      const w4 = new Worker();
      expect(w4.called).to.be.false;
      const w4Complete = throttle.callThrottled(() => w4.work());
      expect(w4.called).to.be.false;

      clock.tick(2000);
      expect(w3.called).to.be.false;
      expect(w4.called).to.be.false;

      w2.complete();

      return w2Complete.then(() => {
        expect(w3.called).to.be.true;
        expect(w4.called).to.be.false;

        w3.complete();

        return w3Complete.then(() => {
          expect(w4.called).to.be.true;

          w1.complete();

          return Promise.all([w1Complete, w4Complete, throttle.whenDrained()]);
        });
      });
    });
  });

  describe('throttling on QPS', () => {
    it('does not throttle with default value', () => {
      const throttle = new AsyncThrottle({});

      const promises = [];
      for (let i = 0; i < 100; i++) {
        const w = new Worker();
        expect(w.called).to.be.false;
        promises.push(throttle.callThrottled(() => w.work()));
        expect(w.called).to.be.true;
      }

      promises.push(throttle.whenDrained());

      return Promise.all(promises);
    });

    it('throttles a sequence of items', () => {
      const throttle = new AsyncThrottle({maxQps: 1});

      const w1 = new Worker();
      expect(w1.called).to.be.false;
      throttle.callThrottled(() => w1.work());
      expect(w1.called).to.be.true;

      clock.tick(1);

      const w2 = new Worker();
      expect(w2.called).to.be.false;
      throttle.callThrottled(() => w2.work());
      expect(w2.called).to.be.false;

      const w3 = new Worker();
      expect(w3.called).to.be.false;
      throttle.callThrottled(() => w3.work());
      expect(w3.called).to.be.false;

      clock.tick(998);
      expect(w2.called).to.be.false;
      expect(w3.called).to.be.false;

      clock.tick(1);
      expect(w2.called).to.be.true;
      expect(w3.called).to.be.false;

      clock.tick(999);
      expect(w3.called).to.be.false;

      clock.tick(1);
      expect(w3.called).to.be.true;

      expect(Date.now()).to.be.eql(2000);

      return throttle.whenDrained();
    });

    it('uses a rolling window', () => {
      const throttle = new AsyncThrottle({maxQps: 2});

      const w1 = new Worker();
      expect(w1.called).to.be.false;
      throttle.callThrottled(() => w1.work());
      expect(w1.called).to.be.true;

      clock.tick(500);

      const w2 = new Worker();
      expect(w2.called).to.be.false;
      throttle.callThrottled(() => w2.work());
      expect(w2.called).to.be.true;

      const w3 = new Worker();
      expect(w3.called).to.be.false;
      throttle.callThrottled(() => w3.work());
      expect(w3.called).to.be.false;

      const w4 = new Worker();
      expect(w4.called).to.be.false;
      throttle.callThrottled(() => w4.work());
      expect(w4.called).to.be.false;

      clock.tick(499);
      expect(w3.called).to.be.false;
      expect(w4.called).to.be.false;

      clock.tick(1);
      expect(w3.called).to.be.true;
      expect(w4.called).to.be.false;

      clock.tick(499);
      expect(w4.called).to.be.false;

      clock.tick(1);
      expect(w4.called).to.be.true;

      expect(Date.now()).to.be.eql(1500);

      return throttle.whenDrained();
    });
  });

  describe('throttling on outstanding work and QPS', () => {
    function advanceOutstandingFirst(throttle) {
      const w1 = new Worker();
      expect(w1.called).to.be.false;
      const w1Complete = throttle.callThrottled(() => w1.work());
      expect(w1.called).to.be.true;

      const w2 = new Worker();
      expect(w2.called).to.be.false;
      throttle.callThrottled(() => w2.work());
      expect(w2.called).to.be.false;

      return w1Complete.then(() => {
        clock.tick(999);
        expect(w2.called).to.be.false;

        clock.tick(1);
        expect(w2.called).to.be.true;

        expect(Date.now()).to.be.eql(1000);

        return throttle.whenDrained();
      });
    }

    function advanceQpsFirst(throttle) {
      const w1 = new Worker(Flags.MANUAL);
      expect(w1.called).to.be.false;
      const w1Complete = throttle.callThrottled(() => w1.work());
      expect(w1.called).to.be.true;

      const w2 = new Worker();
      expect(w2.called).to.be.false;
      const w2Complete = throttle.callThrottled(() => w2.work());
      expect(w2.called).to.be.false;

      clock.tick(2000);
      expect(w2.called).to.be.false;

      w1.complete();

      return w1Complete.then(() => {
        expect(w2.called).to.be.true;

        return Promise.all([w2Complete, throttle.whenDrained()]);
      });
    }

    it('still throttles on QPS', () => {
      return advanceOutstandingFirst(new AsyncThrottle({maxQps: 1, maxOutstanding: 2}));
    });

    it('holds work on QPS when outstanding work relaxes', () => {
      return advanceOutstandingFirst(new AsyncThrottle({maxQps: 1, maxOutstanding: 1}));
    });

    it('still throttles on outstanding work', () => {
      return advanceQpsFirst(new AsyncThrottle({maxQps: 2, maxOutstanding: 1}));
    });

    it('holds work on outstanding work when QPS relaxes', () => {
      return advanceQpsFirst(new AsyncThrottle({maxQps: 1, maxOutstanding: 1}));
    });
  });

  describe('dealing with errors', () => {
    it('handles a failed promise', () => {
      const throttle = new AsyncThrottle({maxQps: 1});

      const w1 = new Worker(Flags.FAIL);
      expect(w1.called).to.be.false;
      const w1Complete = throttle.callThrottled(() => w1.work());
      expect(w1.called).to.be.true;

      const w2 = new Worker();
      expect(w2.called).to.be.false;
      const w2Complete = throttle.callThrottled(() => w2.work());
      expect(w2.called).to.be.false;

      clock.tick(1000);
      expect(w2.called).to.be.true;

      return w1Complete.then(() => {
        return Promise.reject('Expected the first promise to fail.');
      }).catch(() => {
        return Promise.all([w2Complete, throttle.whenDrained()]);
      });
    });

    it('handles an error in the work function', () => {
      const throttle = new AsyncThrottle({maxQps: 1});

      const w1 = new Worker(Flags.ERROR);
      expect(w1.called).to.be.false;
      const w1Complete = throttle.callThrottled(() => w1.work());
      expect(w1.called).to.be.true;

      const w2 = new Worker();
      expect(w2.called).to.be.false;
      const w2Complete = throttle.callThrottled(() => w2.work());
      expect(w2.called).to.be.false;

      clock.tick(1000);
      expect(w2.called).to.be.true;

      return w1Complete.then(() => {
        return Promise.reject('Expected the first promise to fail.');
      }).catch(() => {
        return Promise.all([w2Complete, throttle.whenDrained()]);
      });
    });
  });

  describe('callAllThrottled', () => {
    it('waits for all work', () => {
      const work = [new Worker(), new Worker(), new Worker(Flags.MANUAL)];

      const allComplete = AsyncThrottle.callAllThrottled(work.map(w => () => w.work()), {maxQps: 1});

      expect(work[0].called).to.be.true;
      expect(work[1].called).to.be.false;
      expect(work[2].called).to.be.false;

      clock.tick(4000);
      expect(work[1].called).to.be.true;
      expect(work[2].called).to.be.true;

      const timeoutComplete = new Promise(resolve => {
        setTimeout(resolve, 1000, 'X');
      });

      clock.tick(1000);
      return Promise.race([allComplete, timeoutComplete]).then(value => {
        expect(value).to.be.eql('X');
        work[2].complete();
        return allComplete;
      });
    });

    it('rejects when any reject', () => {
      const work = [new Worker(), new Worker(Flags.FAIL), new Worker(), new Worker()];

      const allComplete = AsyncThrottle.callAllThrottled(work.map(w => () => w.work()), {});

      expect(work[0].called).to.be.true;
      expect(work[1].called).to.be.true;
      expect(work[2].called).to.be.true;
      expect(work[3].called).to.be.true;

      return allComplete
        .then(() => {
          return Promise.reject('Expected the aggregate promise to fail.');
        })
        .catch(error => {
          expect(error).to.be.eql(Worker.promiseError);
          return Promise.resolve();
        });
    });
  });
});
