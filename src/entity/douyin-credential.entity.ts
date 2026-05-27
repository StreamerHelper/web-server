import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DouyinCredential } from '../interface';

@Entity('douyin_credentials')
export class DouyinCredentialEntity implements DouyinCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'cookie_header', type: 'text' })
  cookieHeader: string;

  @Column({ name: 'cookie_names', type: 'jsonb' })
  cookieNames: string[];

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt?: Date | null;

  @Column({ name: 'last_validation_error', type: 'text', nullable: true })
  lastValidationError?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
