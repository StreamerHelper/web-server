import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { JOB_STATUS, JobMetadata, JobStatus } from '../interface';

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'job_id', unique: true })
  @Index()
  jobId: string;

  @Column({ name: 'streamer_id' })
  @Index()
  streamerId: string;

  @Column({ name: 'streamer_name' })
  streamerName: string;

  @Column({ name: 'room_name', nullable: true, length: 500 })
  roomName: string;

  @Column({ name: 'room_id' })
  roomId: string;

  @Column({
    type: 'enum',
    enum: ['bilibili', 'huya', 'douyu'],
    name: 'platform',
  })
  platform: string;

  @Column({ name: 'streamUrl', nullable: true, length: 1000 })
  streamUrl: string;

  @Column({ name: 'danmakuUrl', nullable: true, length: 1000 })
  danmakuUrl: string;

  @Column({
    type: 'enum',
    enum: Object.values(JOB_STATUS),
    default: JOB_STATUS.PENDING,
    name: 'status',
  })
  @Index()
  status: JobStatus;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: JobMetadata;

  @Column({ name: 'video_path', nullable: true })
  videoPath: string;

  @Column({ name: 'danmaku_path', nullable: true })
  danmakuPath: string;

  @Column({ name: 'segment_count', default: 0 })
  segmentCount: number;

  @Column({ name: 'duration', type: 'int', default: 0 })
  duration: number; // 毫秒

  @Column({ name: 'start_time', type: 'timestamptz', nullable: true })
  startTime: Date;

  @Column({ name: 'end_time', type: 'timestamptz', nullable: true })
  endTime: Date;

  @Column({ name: 'error_message', nullable: true })
  errorMessage: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
