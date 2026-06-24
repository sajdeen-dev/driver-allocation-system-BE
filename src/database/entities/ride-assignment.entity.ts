import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { DriverEntity } from './driver.entity';
import { RideEntity } from './ride.entity';

@Entity('ride_assignments')
@Unique(['rideId'])
export class RideAssignmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ride_id', type: 'uuid' })
  rideId!: string;

  @Column({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @Column({ name: 'assignment_time', type: 'timestamptz' })
  assignmentTime!: Date;

  @ManyToOne(() => RideEntity, (ride) => ride.assignments, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'ride_id' })
  ride!: RideEntity;

  @ManyToOne(() => DriverEntity, (driver) => driver.assignments, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'driver_id' })
  driver!: DriverEntity;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
