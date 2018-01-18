import {AsyncThrottle, AsyncThrottleOptions} from '../src/async_throttle';
import {expect} from 'chai';
import * as lolex from 'lolex';

class Worker {
  called = false;
  completed = false;
  complete = () => {};

  resolveImmediately: boolean;

  constructor(resolveImmediately: boolean = true) {
    this.resolveImmediately = resolveImmediately;
  }

  work(): Promise<void> {
    this.called = true;
    if (this.resolveImmediately) {
      this.completed = true;
      return Promise.resolve();
    } else {
      return new Promise<void>(resolve => {
        this.complete = () => {
          this.completed = true;
          this.complete = () => {};
          resolve();
        };
      });
    }
  }
}

describe('AsyncThrottle', () => {
  let clock;

  before(() => {
    clock = lolex.install();
  });

  after(() => {
    clock.uninstall();
  });

  describe('QPS throttling', () => {
    it('does not throttle with default value', () => {
      const throttle = new AsyncThrottle({});

      for (let i = 0; i < 100; i++) {
        const w = new Worker();
        expect(w.called).to.be.false;
        throttle.callThrottled(() => w.work());
        expect(w.called).to.be.true;
      }
    });

    it('throttles 2 items cleanly', () => {
      const throttle = new AsyncThrottle({maxQps: 1});

      const w1 = new Worker();
      expect(w1.called).to.be.false;
      throttle.callThrottled(() => w1.work());
      expect(w1.called).to.be.true;

      const w2 = new Worker();
      expect(w2.called).to.be.false;
      throttle.callThrottled(() => w2.work());
      expect(w2.called).to.be.false;

      clock.tick(999);
      expect(w2.called).to.be.false;

      clock.tick(1);
      expect(w2.called).to.be.true;

      expect(Date.now()).to.be.eql(1000);
    });

    it('throttles 3 items cleanly', () => {
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

      expect(Date.now()).to.be.eql(3000);
    });
  });

  describe('outstanding throttling', () => {
    it('does not throttle with default value', () => {
      const throttle = new AsyncThrottle({});

      for (let i = 0; i < 100; i++) {
        const w = new Worker(false);
        expect(w.called).to.be.false;
        throttle.callThrottled(() => w.work());
        expect(w.called).to.be.true;
      }
    });

    it('throttles 2 items cleanly', () => {
      const throttle = new AsyncThrottle({maxOutstanding: 1});

      const w1 = new Worker(false);
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
        return w2Complete.then(() => throttle.whenDrained());
      });
    });

    it('throttles 3 items cleanly', () => {
      const throttle = new AsyncThrottle({maxOutstanding: 1});

      const w1 = new Worker(false);
      expect(w1.called).to.be.false;
      const w1Complete = throttle.callThrottled(() => w1.work());
      expect(w1.called).to.be.true;

      const w2 = new Worker(false);
      expect(w2.called).to.be.false;
      const w2Complete = throttle.callThrottled(() => w2.work());
      expect(w2.called).to.be.false;

      const w3 = new Worker(true);
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
          return w3Complete.then(() => throttle.whenDrained());
        });
      });
    });
  });
});
