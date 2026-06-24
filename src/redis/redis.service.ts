import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  ACCEPT_RIDE_LUA,
  REDIS_KEYS,
} from './redis.constants';
import { RideState } from '../common/enums/ride-state.enum';

export interface AcceptRideResult {
  success: boolean;
  code: string;
  rideId: string;
  driverId?: string;
  assignmentTime?: string;
  message?: string;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;
  private acceptRideSha!: string;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.client = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: Number(this.configService.get<string>('REDIS_PORT', '6379')),
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    await this.client.connect();
    this.acceptRideSha = (await this.client.script(
      'LOAD',
      ACCEPT_RIDE_LUA,
    )) as string;
    this.logger.log('Redis connected and Lua script loaded');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  getClient(): Redis {
    return this.client;
  }

  async setDriverLocation(
    driverId: string,
    longitude: number,
    latitude: number,
  ): Promise<void> {
    await this.client.geoadd(
      REDIS_KEYS.driversGeo,
      longitude,
      latitude,
      driverId,
    );
  }

  async removeDriverLocation(driverId: string): Promise<void> {
    await this.client.zrem(REDIS_KEYS.driversGeo, driverId);
  }

  async setDriverOnline(driverId: string): Promise<void> {
    await this.client.sadd(REDIS_KEYS.driversOnline, driverId);
  }

  async setDriverOffline(driverId: string): Promise<void> {
    await this.client.srem(REDIS_KEYS.driversOnline, driverId);
  }

  async cacheDriverStatus(driverId: string, status: string): Promise<void> {
    await this.client.set(REDIS_KEYS.driverStatus(driverId), status);
  }

  async setRideState(rideId: string, state: RideState): Promise<void> {
    await this.client.set(REDIS_KEYS.rideState(rideId), state);
  }

  async getRideState(rideId: string): Promise<string | null> {
    return this.client.get(REDIS_KEYS.rideState(rideId));
  }

  async searchNearestDrivers(
    longitude: number,
    latitude: number,
    radiusKm: number,
    count: number,
    excludeDriverIds: string[] = [],
  ): Promise<string[]> {
    const raw = (await this.client.geosearch(
      REDIS_KEYS.driversGeo,
      'FROMLONLAT',
      longitude,
      latitude,
      'BYRADIUS',
      radiusKm,
      'km',
      'ASC',
      'COUNT',
      count * 3,
    )) as string[];

    if (!raw?.length) {
      return [];
    }

    const online = new Set(await this.client.smembers(REDIS_KEYS.driversOnline));
    const excluded = new Set(excludeDriverIds);
    const selected: string[] = [];

    for (const driverId of raw) {
      if (!online.has(driverId) || excluded.has(driverId)) {
        continue;
      }
      selected.push(driverId);
      if (selected.length >= count) {
        break;
      }
    }

    return selected;
  }

  async activateBatch(
    rideId: string,
    batchIndex: number,
    driverIds: string[],
    ttlMs: number,
  ): Promise<void> {
    const pipeline = this.client.pipeline();
    pipeline.set(
      REDIS_KEYS.rideBatchActive(rideId),
      String(batchIndex),
      'PX',
      ttlMs,
    );
    pipeline.del(REDIS_KEYS.rideBatchDrivers(rideId, batchIndex));
    if (driverIds.length) {
      pipeline.sadd(
        REDIS_KEYS.rideBatchDrivers(rideId, batchIndex),
        ...driverIds,
      );
    }
    if (driverIds.length) {
      pipeline.sadd(REDIS_KEYS.rideNotifiedDrivers(rideId), ...driverIds);
    }
    await pipeline.exec();
  }

  async getNotifiedDrivers(rideId: string): Promise<string[]> {
    return this.client.smembers(REDIS_KEYS.rideNotifiedDrivers(rideId));
  }

  async clearRideCache(rideId: string): Promise<void> {
    const keys = await this.client.keys(`ride:${rideId}:*`);
    if (keys.length) {
      await this.client.del(...keys);
    }
  }

  /**
   * Executes the atomic accept script. All concurrent accept requests funnel
   * through this single Lua evaluation — PostgreSQL is updated only after
   * Redis confirms the winner.
   */
  async acceptRideAtomic(params: {
    rideId: string;
    driverId: string;
    assignmentTime: string;
    idempotencyKey?: string;
    batchTtlSeconds?: number;
  }): Promise<AcceptRideResult> {
    const idempotencyKey = params.idempotencyKey ?? '';
    const idempotencyTtl = params.batchTtlSeconds ?? 86400;

    const result = (await this.client.evalsha(
      this.acceptRideSha,
      4,
      REDIS_KEYS.rideAssignment(params.rideId),
      REDIS_KEYS.rideState(params.rideId),
      REDIS_KEYS.rideBatchActive(params.rideId),
      idempotencyKey
        ? REDIS_KEYS.idempotency(`${params.rideId}:${params.driverId}:${idempotencyKey}`)
        : REDIS_KEYS.idempotency(`${params.rideId}:${params.driverId}:noop`),
      params.driverId,
      params.rideId,
      params.assignmentTime,
      idempotencyKey,
      RideState.ASSIGNED,
      String(idempotencyTtl),
    )) as string;

    return JSON.parse(result) as AcceptRideResult;
  }
}
