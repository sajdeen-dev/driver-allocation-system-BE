import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RideEntity } from '../database/entities/ride.entity';
import { RideAssignmentEntity } from '../database/entities/ride-assignment.entity';
import { DriverModule } from '../driver/driver.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { RideController } from './ride.controller';
import { RideSearchService, RideService } from './ride.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([RideEntity, RideAssignmentEntity]),
    DriverModule,
    WebsocketModule,
  ],
  controllers: [RideController],
  providers: [RideService, RideSearchService],
  exports: [RideService, RideSearchService],
})
export class RideModule {}
