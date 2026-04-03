import { Provide, Scope, ScopeEnum } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { BilibiliCredentialEntity } from '../entity/bilibili-credential.entity';
import { BilibiliCredential } from '../interface';

@Provide()
@Scope(ScopeEnum.Singleton)
export class BilibiliCredentialRepository {
  @InjectEntityModel(BilibiliCredentialEntity)
  repo: Repository<BilibiliCredentialEntity>;

  /**
   * 保存凭证
   */
  async save(credential: BilibiliCredential): Promise<BilibiliCredential> {
    return this.repo.save(credential);
  }

  /**
   * 获取有效凭证
   */
  async findValid(): Promise<BilibiliCredential | null> {
    return this.repo.findOne({ where: {} });
  }

  /**
   * 清除所有凭证（登出）
   */
  async clear(): Promise<void> {
    await this.repo.clear();
  }
}
