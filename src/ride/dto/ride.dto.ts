import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreateRideDto {
  @IsString()
  @IsNotEmpty()
  passengerId!: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  pickupLatitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  pickupLongitude!: number;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  destinationLatitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  destinationLongitude?: number;
}

export class AcceptRideDto {
  @IsUUID()
  driverId!: string;
}

export class AcceptRideHeadersDto {
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
