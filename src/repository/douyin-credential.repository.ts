import { Provide, Scope, ScopeEnum } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { DouyinCredentialEntity } from '../entity/douyin-credential.entity';
import { DouyinCredential } from '../interface';

@Provide()
@Scope(ScopeEnum.Singleton)
export class DouyinCredentialRepository {
  @InjectEntityModel(DouyinCredentialEntity)
  repo: Repository<DouyinCredentialEntity>;

  async saveCredential(
    credential: DouyinCredential
  ): Promise<DouyinCredential> {
    await this.clear();
    return this.repo.save(credential);
  }

  async findLatest(): Promise<DouyinCredential | null> {
    return this.repo.findOne({
      where: {},
      order: {
        updatedAt: 'DESC',
      },
    });
  }

  async clear(): Promise<void> {
    await this.repo.clear();
  }
}
