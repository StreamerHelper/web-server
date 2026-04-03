import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StreamerInfo } from '../interface';

@Entity('streamers')
export class Streamer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'streamer_id', unique: true })
  @Index()
  streamerId: string;

  @Column({ name: 'name' })
  name: string;

  @Column({
    type: 'enum',
    enum: ['bilibili', 'huya', 'douyu'],
    name: 'platform',
  })
  platform: string;

  @Column({ name: 'room_id' })
  roomId: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'last_check_time', type: 'timestamptz', nullable: true })
  lastCheckTime: Date;

  @Column({ name: 'last_live_time', type: 'timestamptz', nullable: true })
  lastLiveTime: Date;

  @Column({ name: 'recordSettings', type: 'jsonb', nullable: true })
  recordSettings: {
    quality?: string;
    detectHighlights?: boolean;
  };

  @Column({ name: 'uploadSettings', type: 'jsonb', nullable: true })
  uploadSettings: {
    autoUpload?: boolean;
    title?: string;
    description?: string;
    tags?: string[];
    tid?: number;
  };

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // 虚拟字段，用于快速转换
  toInfo(): StreamerInfo {
    return {
      id: this.id,
      streamerId: this.streamerId,
      name: this.name,
      platform: this.platform as any,
      roomId: this.roomId,
      isActive: this.isActive,
      recordSettings: this.recordSettings,
      uploadSettings: this.uploadSettings,
    };
  }
}
