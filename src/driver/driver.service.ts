import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DriverEntity } from '../database/entities/driver.entity';
import { DriverStatus } from '../common/enums/driver-status.enum';
import { RedisService } from '../redis/redis.service';
import {
  CreateDriverDto,
  UpdateDriverLocationDto,
  UpdateDriverStatusDto,
} from './dto/driver.dto';

@Injectable()
export class DriverService {
  constructor(
    @InjectRepository(DriverEntity)
    private readonly driverRepository: Repository<DriverEntity>,
    private readonly redisService: RedisService,
  ) {}

  async register(dto: CreateDriverDto): Promise<DriverEntity> {
    const existing = await this.driverRepository.findOne({
      where: { phone: dto.phone },
    });
    if (existing) {
      throw new ConflictException('Driver with this phone already exists');
    }

    const driver = this.driverRepository.create({
      name: dto.name,
      phone: dto.phone,
      status: DriverStatus.OFFLINE,
    });

    return this.driverRepository.save(driver);
  }

  async updateLocation(
    id: string,
    dto: UpdateDriverLocationDto,
  ): Promise<DriverEntity> {
    const driver = await this.findById(id);

    driver.latitude = dto.latitude;
    driver.longitude = dto.longitude;
    const saved = await this.driverRepository.save(driver);

    if (driver.status === DriverStatus.ONLINE) {
      await this.redisService.setDriverLocation(
        driver.id,
        dto.longitude,
        dto.latitude,
      );
    }

    return saved;
  }

  async updateStatus(
    id: string,
    dto: UpdateDriverStatusDto,
  ): Promise<DriverEntity> {
    const driver = await this.findById(id);
    driver.status = dto.status;
    const saved = await this.driverRepository.save(driver);

    await this.redisService.cacheDriverStatus(driver.id, dto.status);

    if (dto.status === DriverStatus.ONLINE) {
      await this.redisService.setDriverOnline(driver.id);
      await this.redisService.setDriverLocation(
        driver.id,
        driver.longitude,
        driver.latitude,
      );
    } else {
      await this.redisService.setDriverOffline(driver.id);
      await this.redisService.removeDriverLocation(driver.id);
    }

    return saved;
  }

  async findById(id: string): Promise<DriverEntity> {
    const driver = await this.driverRepository.findOne({ where: { id } });
    if (!driver) {
      throw new NotFoundException(`Driver ${id} not found`);
    }
    return driver;
  }

  async findByIds(ids: string[]): Promise<DriverEntity[]> {
    if (!ids.length) {
      return [];
    }
    return this.driverRepository.find({ where: { id: In(ids) } });
  }
}
