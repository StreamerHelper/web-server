import {
  Check,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { DouyinAuthState, DouyinCredential } from '../interface';

@Entity('douyin_credentials')
@Index('UQ_douyin_credentials_slot', ['slot'], { unique: true })
@Check(
  'CHK_douyin_credentials_state',
  "\"state\" IN ('unconfigured', 'unknown', 'validating', 'valid', 'challenged', 'expired')"
)
@Check('CHK_douyin_credentials_cookie_header_null', '"cookie_header" IS NULL')
export class DouyinCredentialEntity implements DouyinCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32, default: 'default' })
  slot: string;

  @Column({ type: 'varchar', length: 32, default: 'unknown' })
  state: DouyinAuthState;

  @Column({
    name: 'cookie_header',
    type: 'text',
    nullable: true,
    select: false,
  })
  cookieHeader?: string | null;

  @Column({ name: 'cookie_names', type: 'jsonb' })
  cookieNames: string[];

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt?: Date | null;

  @Column({ name: 'auth_expires_at', type: 'timestamptz', nullable: true })
  authExpiresAt?: Date | null;

  @Column({ name: 'state_changed_at', type: 'timestamptz', nullable: true })
  stateChangedAt?: Date | null;

  @Column({
    name: 'last_validation_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastValidationCode?: DouyinCredential['lastValidationCode'];

  @Column({ name: 'last_validation_error', type: 'text', nullable: true })
  lastValidationError?: string | null;

  @Column({ name: 'operation_id', type: 'varchar', length: 64, nullable: true })
  operationId?: string | null;

  @Column({ type: 'integer', default: 0 })
  generation: number;

  @VersionColumn({ default: 1 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
