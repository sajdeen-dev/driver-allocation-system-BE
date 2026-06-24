import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DriverStatus } from '../../common/enums/driver-status.enum';
import { RideAssignmentEntity } from './ride-assignment.entity';

@Entity('drivers')
export class DriverEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ length: 20, unique: true })
  phone!: string;

  @Column({ type: 'enum', enum: DriverStatus, default: DriverStatus.OFFLINE })
  status!: DriverStatus;

  @Column({ type: 'double precision', default: 0 })
  latitude!: number;

  @Column({ type: 'double precision', default: 0 })
  longitude!: number;

  @OneToMany(() => RideAssignmentEntity, (assignment) => assignment.driver)
  assignments!: RideAssignmentEntity[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
