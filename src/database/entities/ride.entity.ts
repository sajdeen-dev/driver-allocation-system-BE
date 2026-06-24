import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RideState } from '../../common/enums/ride-state.enum';
import { RideAssignmentEntity } from './ride-assignment.entity';

@Entity('rides')
export class RideEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'passenger_id', length: 100 })
  passengerId!: string;

  @Column({ name: 'pickup_latitude', type: 'double precision' })
  pickupLatitude!: number;

  @Column({ name: 'pickup_longitude', type: 'double precision' })
  pickupLongitude!: number;

  @Column({
    name: 'destination_latitude',
    type: 'double precision',
    nullable: true,
  })
  destinationLatitude!: number | null;

  @Column({
    name: 'destination_longitude',
    type: 'double precision',
    nullable: true,
  })
  destinationLongitude!: number | null;

  @Column({ type: 'enum', enum: RideState, default: RideState.REQUESTED })
  state!: RideState;

  @Column({ name: 'assigned_driver_id', type: 'uuid', nullable: true })
  assignedDriverId!: string | null;

  @Column({ name: 'assignment_time', type: 'timestamptz', nullable: true })
  assignmentTime!: Date | null;

  @Column({ name: 'current_batch_index', type: 'int', default: 0 })
  currentBatchIndex!: number;

  @OneToMany(() => RideAssignmentEntity, (assignment) => assignment.ride)
  assignments!: RideAssignmentEntity[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
