import { DriverStatus } from './driver-status.enum';
import { RideState } from './ride-state.enum';

describe('Domain enums', () => {
  it('defines driver statuses', () => {
    expect(DriverStatus.ONLINE).toBe('ONLINE');
    expect(DriverStatus.OFFLINE).toBe('OFFLINE');
  });

  it('defines ride lifecycle states', () => {
    expect(Object.values(RideState)).toEqual([
      'REQUESTED',
      'SEARCHING',
      'ASSIGNED',
      'TIMEOUT',
      'COMPLETED',
      'CANCELLED',
    ]);
  });
});
