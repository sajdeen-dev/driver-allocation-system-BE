import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { DriverService } from './driver.service';
import {
  CreateDriverDto,
  UpdateDriverLocationDto,
  UpdateDriverStatusDto,
} from './dto/driver.dto';

@Controller('drivers')
export class DriverController {
  constructor(private readonly driverService: DriverService) {}

  @Post()
  register(@Body() dto: CreateDriverDto) {
    return this.driverService.register(dto);
  }

  @Patch(':id/location')
  updateLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverLocationDto,
  ) {
    return this.driverService.updateLocation(id, dto);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverStatusDto,
  ) {
    return this.driverService.updateStatus(id, dto);
  }
}
