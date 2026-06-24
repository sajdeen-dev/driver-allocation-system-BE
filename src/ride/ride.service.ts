import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { RideEntity } from '../database/entities/ride.entity';
import { RideAssignmentEntity } from '../database/entities/ride-assignment.entity';
import { RideState } from '../common/enums/ride-state.enum';
import { RedisService } from '../redis/redis.service';
import { DriverGateway } from '../websocket/driver.gateway';
import { DriverService } from '../driver/driver.service';
import { CreateRideDto } from './dto/ride.dto';

@Injectable()
export class RideSearchService {
  private readonly logger = new Logger(RideSearchService.name);
  private readonly pendingTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly radiusKm: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  constructor(
    @InjectRepository(RideEntity)
    private readonly rideRepository: Repository<RideEntity>,
    private readonly redisService: RedisService,
    private readonly driverGateway: DriverGateway,
    private readonly driverService: DriverService,
    private readonly configService: ConfigService,
  ) {
    this.radiusKm = Number(
      this.configService.get<string>('RIDE_SEARCH_RADIUS_KM', '50'),
    );
    this.batchSize = Number(
      this.configService.get<string>('RIDE_SEARCH_BATCH_SIZE', '5'),
    );
    this.timeoutMs = Number(
      this.configService.get<string>('RIDE_SEARCH_TIMEOUT_MS', '30000'),
    );
  }

  async startSearch(ride: RideEntity): Promise<RideEntity> {
    ride.state = RideState.SEARCHING;
    await this.rideRepository.save(ride);
    await this.redisService.setRideState(ride.id, RideState.SEARCHING);

    await this.dispatchBatch(ride, 0);
    return ride;
  }

  private async dispatchBatch(
    ride: RideEntity,
    batchIndex: number,
  ): Promise<void> {
    const freshRide = await this.rideRepository.findOne({
      where: { id: ride.id },
    });
    if (!freshRide || freshRide.state !== RideState.SEARCHING) {
      return;
    }

    const notified = await this.redisService.getNotifiedDrivers(ride.id);
    const candidates = await this.redisService.searchNearestDrivers(
      ride.pickupLongitude,
      ride.pickupLatitude,
      this.radiusKm,
      this.batchSize,
      notified,
    );

    if (!candidates.length) {
      await this.markTimeout(ride.id);
      return;
    }

    freshRide.currentBatchIndex = batchIndex;
    await this.rideRepository.save(freshRide);

    const expiresAt = new Date(Date.now() + this.timeoutMs);
    await this.redisService.activateBatch(
      ride.id,
      batchIndex,
      candidates,
      this.timeoutMs,
    );

    this.driverGateway.notifyDriversBatch(candidates, {
      rideId: ride.id,
      pickupLatitude: ride.pickupLatitude,
      pickupLongitude: ride.pickupLongitude,
      batchIndex,
      expiresAt: expiresAt.toISOString(),
    });

    this.scheduleBatchTimeout(ride.id, batchIndex);
  }

  /**
   * Batch timeout runs in-process. When it fires we verify the batch is still
   * active in Redis before advancing — this prevents duplicate batches if a
   * driver accepted milliseconds earlier.
   */
  private scheduleBatchTimeout(rideId: string, batchIndex: number): void {
    const existing = this.pendingTimeouts.get(rideId);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      void this.handleBatchTimeout(rideId, batchIndex);
    }, this.timeoutMs);

    this.pendingTimeouts.set(rideId, timeout);
  }

  private async handleBatchTimeout(
    rideId: string,
    batchIndex: number,
  ): Promise<void> {
    this.pendingTimeouts.delete(rideId);

    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride || ride.state !== RideState.SEARCHING) {
      return;
    }

    const cachedState = await this.redisService.getRideState(rideId);
    if (cachedState === RideState.ASSIGNED) {
      return;
    }

    if (ride.currentBatchIndex !== batchIndex) {
      return;
    }

    this.logger.log(`Batch ${batchIndex} expired for ride ${rideId}`);

    const notified = await this.redisService.getNotifiedDrivers(rideId);
    const nextCandidates = await this.redisService.searchNearestDrivers(
      ride.pickupLongitude,
      ride.pickupLatitude,
      this.radiusKm,
      this.batchSize,
      notified,
    );

    if (!nextCandidates.length) {
      await this.markTimeout(rideId);
      return;
    }

    await this.dispatchBatch(ride, batchIndex + 1);
  }

  async markTimeout(rideId: string): Promise<void> {
    const pending = this.pendingTimeouts.get(rideId);
    if (pending) {
      clearTimeout(pending);
      this.pendingTimeouts.delete(rideId);
    }

    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride || ride.state !== RideState.SEARCHING) {
      return;
    }

    ride.state = RideState.TIMEOUT;
    await this.rideRepository.save(ride);
    await this.redisService.setRideState(rideId, RideState.TIMEOUT);
    this.logger.warn(`Ride ${rideId} marked TIMEOUT — no driver accepted`);
  }

  cancelPendingTimeout(rideId: string): void {
    const pending = this.pendingTimeouts.get(rideId);
    if (pending) {
      clearTimeout(pending);
      this.pendingTimeouts.delete(rideId);
    }
  }
}

@Injectable()
export class RideService {
  private readonly logger = new Logger(RideService.name);

  constructor(
    @InjectRepository(RideEntity)
    private readonly rideRepository: Repository<RideEntity>,
    @InjectRepository(RideAssignmentEntity)
    private readonly assignmentRepository: Repository<RideAssignmentEntity>,
    private readonly redisService: RedisService,
    private readonly rideSearchService: RideSearchService,
    private readonly driverService: DriverService,
  ) {}

  async createRide(dto: CreateRideDto): Promise<RideEntity> {
    const ride = this.rideRepository.create({
      passengerId: dto.passengerId,
      pickupLatitude: dto.pickupLatitude,
      pickupLongitude: dto.pickupLongitude,
      destinationLatitude: dto.destinationLatitude ?? null,
      destinationLongitude: dto.destinationLongitude ?? null,
      state: RideState.REQUESTED,
    });

    const saved = await this.rideRepository.save(ride);
    await this.redisService.setRideState(saved.id, RideState.REQUESTED);

    return this.rideSearchService.startSearch(saved);
  }

  async acceptRide(
    rideId: string,
    driverId: string,
    idempotencyKey?: string,
  ): Promise<{
    success: boolean;
    code: string;
    rideId: string;
    driverId?: string;
    assignmentTime?: string;
    message?: string;
  }> {
    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride) {
      throw new NotFoundException(`Ride ${rideId} not found`);
    }

    await this.driverService.findById(driverId);

    const assignmentTime = new Date().toISOString();

    // Redis Lua script is the single source of truth for concurrent acceptance.
    const result = await this.redisService.acceptRideAtomic({
      rideId,
      driverId,
      assignmentTime,
      idempotencyKey,
    });

    if (result.success) {
      await this.persistAssignment(ride, driverId, assignmentTime);
      this.rideSearchService.cancelPendingTimeout(rideId);
      this.logger.log(`Ride ${rideId} assigned to driver ${driverId}`);
      return result;
    }

    if (result.code === 'BATCH_EXPIRED' || result.code === 'RIDE_NOT_ACCEPTABLE') {
      throw new GoneException(result.message ?? 'Acceptance window closed');
    }

    if (result.code === 'ALREADY_CLAIMED' || result.code === 'LOST_RACE') {
      throw new ConflictException(result.message ?? 'Ride already claimed');
    }

    if (result.code === 'INVALID_STATE') {
      throw new BadRequestException(result.message ?? 'Invalid ride state');
    }

    throw new ConflictException(result.message ?? 'Unable to accept ride');
  }

  /**
   * PostgreSQL write happens only after Redis confirms the winner.
   * Unique constraint on ride_id prevents duplicate assignment rows if
   * two app instances somehow both attempt persistence.
   */
  private async persistAssignment(
    ride: RideEntity,
    driverId: string,
    assignmentTimeIso: string,
  ): Promise<void> {
    const assignmentTime = new Date(assignmentTimeIso);

    const existing = await this.assignmentRepository.findOne({
      where: { rideId: ride.id },
    });

    if (existing) {
      if (existing.driverId === driverId) {
        return;
      }
      throw new ConflictException('Ride already assigned to another driver');
    }

    ride.state = RideState.ASSIGNED;
    ride.assignedDriverId = driverId;
    ride.assignmentTime = assignmentTime;

    await this.rideRepository.save(ride);
    await this.redisService.setRideState(ride.id, RideState.ASSIGNED);

    await this.assignmentRepository.save(
      this.assignmentRepository.create({
        rideId: ride.id,
        driverId,
        assignmentTime,
      }),
    );
  }

  async findById(id: string): Promise<RideEntity> {
    const ride = await this.rideRepository.findOne({
      where: { id },
      relations: { assignments: true },
    });
    if (!ride) {
      throw new NotFoundException(`Ride ${id} not found`);
    }
    return ride;
  }
}
