import { Provide, Scope, ScopeEnum } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { DouyinCredentialEntity } from '../entity/douyin-credential.entity';
import {
  DouyinAuthFailureCode,
  DouyinAuthState,
  DouyinCredential,
} from '../interface';

const DEFAULT_SLOT = 'default';

export interface DouyinCredentialTransition {
  state: DouyinAuthState;
  cookieNames?: string[];
  verifiedAt?: Date | null;
  authExpiresAt?: Date | null;
  lastValidationCode?: DouyinAuthFailureCode | null;
  lastValidationError?: string | null;
}

export interface DouyinCredentialOperation {
  id: string;
  generation: number;
}

export interface DouyinCredentialOperationStart {
  credential: DouyinCredential;
  operation: DouyinCredentialOperation;
}

@Provide()
@Scope(ScopeEnum.Singleton)
export class DouyinCredentialRepository {
  @InjectEntityModel(DouyinCredentialEntity)
  repo: Repository<DouyinCredentialEntity>;

  async transition(
    transition: DouyinCredentialTransition,
    operation?: DouyinCredentialOperation,
    completeOperation = false
  ): Promise<DouyinCredential | null> {
    return this.repo.manager.transaction(async manager => {
      const { repository, current } = await this.lockSingleton(manager);
      if (
        operation &&
        (current.operationId !== operation.id ||
          current.generation !== operation.generation)
      ) {
        return null;
      }
      return repository.save(
        this.createNextCredential(repository, current, transition, {
          operationId: completeOperation ? null : current.operationId,
          generation: current.generation,
        })
      );
    });
  }

  async beginOperation(
    operationId: string,
    transition: DouyinCredentialTransition
  ): Promise<DouyinCredentialOperationStart> {
    return this.repo.manager.transaction(async manager => {
      const { repository, current } = await this.lockSingleton(manager);
      const operation = {
        id: operationId,
        generation: current.generation + 1,
      };
      const credential = await repository.save(
        this.createNextCredential(repository, current, transition, {
          operationId: operation.id,
          generation: operation.generation,
        })
      );
      return { credential, operation };
    });
  }

  async invalidateOperation(
    transition: DouyinCredentialTransition
  ): Promise<DouyinCredential> {
    return this.repo.manager.transaction(async manager => {
      const { repository, current } = await this.lockSingleton(manager);
      return repository.save(
        this.createNextCredential(repository, current, transition, {
          operationId: null,
          generation: current.generation + 1,
        })
      );
    });
  }

  async findLatest(): Promise<DouyinCredential | null> {
    return this.repo.findOne({
      where: { slot: DEFAULT_SLOT },
    });
  }

  async clear(): Promise<void> {
    await this.repo.delete({ slot: DEFAULT_SLOT });
  }

  private async lockSingleton(manager: EntityManager): Promise<{
    repository: Repository<DouyinCredentialEntity>;
    current: DouyinCredentialEntity;
  }> {
    const repository = manager.getRepository(DouyinCredentialEntity);
    await repository
      .createQueryBuilder()
      .insert()
      .into(DouyinCredentialEntity)
      .values({
        slot: DEFAULT_SLOT,
        state: 'unknown',
        cookieHeader: null,
        cookieNames: [],
        operationId: null,
        generation: 0,
      })
      .orIgnore()
      .execute();
    const current = await repository.findOneOrFail({
      where: { slot: DEFAULT_SLOT },
      lock: { mode: 'pessimistic_write' },
    });
    return { repository, current };
  }

  private createNextCredential(
    repository: Repository<DouyinCredentialEntity>,
    current: DouyinCredentialEntity,
    transition: DouyinCredentialTransition,
    operation: {
      operationId: string | null | undefined;
      generation: number;
    }
  ): DouyinCredentialEntity {
    const now = new Date();
    return repository.create({
      ...current,
      slot: DEFAULT_SLOT,
      state: transition.state,
      cookieHeader: null,
      cookieNames: transition.cookieNames ?? current.cookieNames ?? [],
      verifiedAt:
        transition.verifiedAt !== undefined
          ? transition.verifiedAt
          : current.verifiedAt ?? null,
      authExpiresAt:
        transition.authExpiresAt !== undefined
          ? transition.authExpiresAt
          : current.authExpiresAt ?? null,
      stateChangedAt:
        current.state !== transition.state
          ? now
          : current.stateChangedAt || now,
      lastValidationCode:
        transition.lastValidationCode !== undefined
          ? transition.lastValidationCode
          : current.lastValidationCode ?? null,
      lastValidationError:
        transition.lastValidationError !== undefined
          ? transition.lastValidationError
          : current.lastValidationError ?? null,
      operationId: operation.operationId,
      generation: operation.generation,
    });
  }
}
