import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BilibiliCredential } from '../interface';

@Entity('bilibili_credentials')
export class BilibiliCredentialEntity implements BilibiliCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'access_token', type: 'varchar', length: 256 })
  accessToken: string;

  @Column({ name: 'refresh_token', type: 'varchar', length: 256 })
  refreshToken: string;

  @Column({ name: 'mid', type: 'bigint' })
  mid: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'cookies', type: 'jsonb' })
  cookies: {
    SESSDATA: string;
    bili_jct: string;
    Dedeuserid: string;
  };

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
