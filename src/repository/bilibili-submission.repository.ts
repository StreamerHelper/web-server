import { Provide, Scope, ScopeEnum } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  BilibiliSubmissionEntity,
  PartStatus,
  SubmissionPart,
  SubmissionStatus,
} from '../entity/bilibili-submission.entity';

@Provide()
@Scope(ScopeEnum.Singleton)
export class BilibiliSubmissionRepository {
  @InjectEntityModel(BilibiliSubmissionEntity)
  repo: Repository<BilibiliSubmissionEntity>;

  /**
   * 创建投稿记录
   */
  async create(
    data: Partial<BilibiliSubmissionEntity>
  ): Promise<BilibiliSubmissionEntity> {
    const submission = this.repo.create(data);
    return this.repo.save(submission);
  }

  /**
   * 根据ID获取投稿
   */
  async findById(id: string): Promise<BilibiliSubmissionEntity | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * 根据JobId获取投稿列表
   */
  async findByJobId(jobId: string): Promise<BilibiliSubmissionEntity[]> {
    return this.repo.find({ where: { jobId }, order: { createdAt: 'DESC' } });
  }

  async findByJobIds(jobIds: string[]): Promise<BilibiliSubmissionEntity[]> {
    if (jobIds.length === 0) {
      return [];
    }

    return this.repo.find({
      where: { jobId: In(jobIds) },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * 获取待处理的投稿（用于断点续传）
   */
  async findPendingSubmissions(): Promise<BilibiliSubmissionEntity[]> {
    return this.repo.find({
      where: {
        status: In([SubmissionStatus.PENDING, SubmissionStatus.UPLOADING]),
      },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * 需要恢复（重新入队）的投稿。
   *
   * 只包含真正“没走完”的行：pending / uploading / submitting。
   * 已完成的行即使 parts 元数据有缺口，也不在这里重跑——那样会让一个
   * 已经在 B 站上线的稿件因为原片被自动清理而重新合并、失败、再被标成
   * failed。元数据缺口只做只读 observation，由运维对账处理。
   */
  async findRecoverableSubmissions(): Promise<BilibiliSubmissionEntity[]> {
    return this.repo.find({
      where: {
        status: In([
          SubmissionStatus.PENDING,
          SubmissionStatus.UPLOADING,
          SubmissionStatus.SUBMITTING,
        ]),
      },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * 已完成但 parts 元数据不完整的行（cid / filename 缺失）。
   * 仅用于启动时告警，不会再触发合并或上传。
   */
  async findCompletedWithIncompleteParts(): Promise<
    BilibiliSubmissionEntity[]
  > {
    return this.repo
      .createQueryBuilder('submission')
      .where('submission.status = :completedStatus', {
        completedStatus: SubmissionStatus.COMPLETED,
      })
      .andWhere(
        `EXISTS (
          SELECT 1
          FROM jsonb_array_elements(submission.parts) AS part
          WHERE part->>'status' <> :completedPartStatus
            OR COALESCE(part->>'filename', '') = ''
            OR COALESCE(part->>'cid', '') IN ('', '0')
        )`,
        { completedPartStatus: PartStatus.COMPLETED }
      )
      .orderBy('submission.createdAt', 'ASC')
      .getMany();
  }

  /**
   * 更新投稿状态
   */
  async updateStatus(
    id: string,
    status: SubmissionStatus,
    error?: string
  ): Promise<void> {
    const updateData: Partial<BilibiliSubmissionEntity> = { status };
    if (error) {
      updateData.lastError = error;
    }
    await this.repo.update({ id }, updateData);
  }

  /**
   * 更新分P状态
   */
  async updatePartStatus(
    id: string,
    partIndex: number,
    status: PartStatus,
    data?: Partial<SubmissionPart>
  ): Promise<void> {
    const submission = await this.findById(id);
    if (!submission) return;

    const parts = [...submission.parts];
    const part = parts.find(p => p.index === partIndex);
    if (!part) return;

    part.status = status;
    if (data) {
      Object.assign(part, data);
    }

    // 更新已完成的分P数
    const completedParts = parts.filter(
      p => p.status === PartStatus.COMPLETED
    ).length;

    await this.repo.update({ id }, { parts, completedParts });
  }

  /**
   * 替换完整分P列表
   */
  async updateParts(id: string, parts: SubmissionPart[]): Promise<void> {
    const completedParts = parts.filter(
      p => p.status === PartStatus.COMPLETED
    ).length;

    await this.repo.update(
      { id },
      {
        parts,
        totalParts: parts.length,
        completedParts,
      }
    );
  }

  /**
   * 更新投稿结果（成功后）
   */
  async updateSubmissionResult(
    id: string,
    bvid: string,
    avid: number
  ): Promise<void> {
    await this.updateUploadedResult(id, bvid, avid);
    await this.completeSubmission(id);
  }

  async updateUploadedResult(
    id: string,
    bvid: string,
    avid: number
  ): Promise<void> {
    await this.repo.update(
      { id },
      {
        bvid,
        avid,
      }
    );
  }

  async completeSubmission(id: string): Promise<void> {
    await this.repo.update(
      { id },
      {
        status: SubmissionStatus.COMPLETED,
        lastError: null,
      }
    );
  }

  async updateCollectionResult(
    id: string,
    episodeId?: number | null
  ): Promise<void> {
    await this.repo.update(
      { id },
      {
        collectionEpisodeId: episodeId ?? null,
        collectionAddedAt: new Date(),
      }
    );
  }

  /**
   * 保存投稿
   */
  async save(
    submission: BilibiliSubmissionEntity
  ): Promise<BilibiliSubmissionEntity> {
    return this.repo.save(submission);
  }

  /**
   * 删除投稿
   */
  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }

  /**
   * 获取投稿列表（分页）
   */
  async list(options: {
    page?: number;
    pageSize?: number;
    jobId?: string;
    status?: SubmissionStatus;
  }): Promise<{ items: BilibiliSubmissionEntity[]; total: number }> {
    const { page = 1, pageSize = 20, jobId, status } = options;

    const qb = this.repo.createQueryBuilder('submission');

    if (jobId) {
      qb.andWhere('submission.jobId = :jobId', { jobId });
    }
    if (status) {
      qb.andWhere('submission.status = :status', { status });
    }

    qb.orderBy('submission.createdAt', 'DESC');
    qb.skip((page - 1) * pageSize).take(pageSize);

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }
}
