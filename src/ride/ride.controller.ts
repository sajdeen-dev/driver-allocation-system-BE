import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { RideService } from './ride.service';
import { AcceptRideDto, CreateRideDto } from './dto/ride.dto';

@Controller('rides')
export class RideController {
  constructor(private readonly rideService: RideService) {}

  @Post()
  createRide(@Body() dto: CreateRideDto) {
    return this.rideService.createRide(dto);
  }

  @Post(':rideId/accept')
  @HttpCode(HttpStatus.OK)
  acceptRide(
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() dto: AcceptRideDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.rideService.acceptRide(rideId, dto.driverId, idempotencyKey);
  }

  @Get(':rideId')
  getRide(@Param('rideId', ParseUUIDPipe) rideId: string) {
    return this.rideService.findById(rideId);
  }
}
