import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { DriverStatus } from '../../common/enums/driver-status.enum';
import { RedisService } from '../../redis/redis.service';
import { DataSource } from 'typeorm';

/**
 * Concurrency integration test.
 *
 * Requires PostgreSQL and Redis (use `docker compose up -d postgres redis`).
 * Simulates 20 drivers accepting the same ride simultaneously via Promise.all().
 * Redis Lua script must guarantee exactly one winner.
 */
describe('Ride acceptance concurrency (integration)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let redisService: RedisService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    redisService = moduleFixture.get(RedisService);
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE ride_assignments, rides, drivers RESTART IDENTITY CASCADE',
    );
    // Do not FLUSHDB — it removes loaded Lua scripts and breaks acceptRideAtomic().
    const client = redisService.getClient();
    for (const pattern of ['drivers:*', 'driver:*', 'ride:*', 'idempotency:*']) {
      const keys = await client.keys(pattern);
      if (keys.length) {
        await client.del(...keys);
      }
    }
  });

  it('allows exactly one successful assignment under 20 concurrent accepts', async () => {
    const baseLat = 12.9716;
    const baseLng = 77.5946;
    const driverIds: string[] = [];

    for (let i = 0; i < 20; i++) {
      const driverRes = await request(app.getHttpServer())
        .post('/drivers')
        .send({ name: `Driver ${i}`, phone: `+100000000${i}` })
        .expect(201);

      const driverId = driverRes.body.id as string;
      driverIds.push(driverId);

      await request(app.getHttpServer())
        .patch(`/drivers/${driverId}/location`)
        .send({
          latitude: baseLat + i * 0.0001,
          longitude: baseLng + i * 0.0001,
        })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/drivers/${driverId}/status`)
        .send({ status: DriverStatus.ONLINE })
        .expect(200);
    }

    const rideRes = await request(app.getHttpServer())
      .post('/rides')
      .send({
        passengerId: 'passenger-1',
        pickupLatitude: baseLat,
        pickupLongitude: baseLng,
      })
      .expect(201);

    const rideId = rideRes.body.id as string;

    const acceptResults = await Promise.all(
      driverIds.map((driverId) =>
        request(app.getHttpServer())
          .post(`/rides/${rideId}/accept`)
          .set('Idempotency-Key', `accept-${driverId}`)
          .send({ driverId })
          .then((res) => ({ driverId, status: res.status, body: res.body })),
      ),
    );

    const successes = acceptResults.filter((r) => r.status === 200);
    const failures = acceptResults.filter((r) => r.status >= 400);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(19);

    const rideDetail = await request(app.getHttpServer())
      .get(`/rides/${rideId}`)
      .expect(200);

    expect(rideDetail.body.state).toBe('ASSIGNED');
    expect(rideDetail.body.assignments).toHaveLength(1);
    expect(rideDetail.body.assignedDriverId).toBe(successes[0].driverId);

    const duplicateRetry = await request(app.getHttpServer())
      .post(`/rides/${rideId}/accept`)
      .set('Idempotency-Key', `accept-${successes[0].driverId}`)
      .send({ driverId: successes[0].driverId });

    expect([200]).toContain(duplicateRetry.status);
  }, 60000);
});
