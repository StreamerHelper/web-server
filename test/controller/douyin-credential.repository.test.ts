import { DouyinCredentialRepository } from '../../src/repository/douyin-credential.repository';

describe('DouyinCredentialRepository', () => {
  const createInsertBuilder = () => {
    const builder: any = {
      insert: jest.fn(() => builder),
      into: jest.fn(() => builder),
      values: jest.fn(() => builder),
      orIgnore: jest.fn(() => builder),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    return builder;
  };

  it('updates the singleton slot atomically and never writes a Cookie header', async () => {
    const repository = new DouyinCredentialRepository() as any;
    const current = {
      id: 'credential-id',
      slot: 'default',
      state: 'unknown',
      cookieNames: [],
      operationId: null,
      generation: 0,
    };
    const insertBuilder = createInsertBuilder();
    const entityRepository = {
      createQueryBuilder: jest.fn(() => insertBuilder),
      findOneOrFail: jest.fn().mockResolvedValue(current),
      create: jest.fn(value => value),
      save: jest.fn(async value => ({
        ...value,
        id: 'credential-id',
        version: 1,
      })),
    };
    repository.repo = {
      manager: {
        transaction: jest.fn(async callback =>
          callback({
            getRepository: () => entityRepository,
          })
        ),
      },
    };

    const saved = await repository.transition({
      state: 'valid',
      cookieNames: ['sessionid'],
      verifiedAt: new Date('2026-07-28T00:00:00.000Z'),
    });

    expect(insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
    expect(entityRepository.findOneOrFail).toHaveBeenCalledWith({
      where: { slot: 'default' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(entityRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'default',
        state: 'valid',
        cookieHeader: null,
        cookieNames: ['sessionid'],
      })
    );
    expect(saved).not.toHaveProperty('cookieHeader', expect.any(String));
  });

  it('preserves stateChangedAt for an idempotent transition', async () => {
    const repository = new DouyinCredentialRepository() as any;
    const stateChangedAt = new Date('2026-07-28T00:00:00.000Z');
    const current = {
      id: 'credential-id',
      slot: 'default',
      state: 'challenged',
      cookieNames: [],
      stateChangedAt,
      operationId: null,
      generation: 2,
    };
    const insertBuilder = createInsertBuilder();
    const entityRepository = {
      createQueryBuilder: jest.fn(() => insertBuilder),
      findOneOrFail: jest.fn().mockResolvedValue(current),
      create: jest.fn(value => value),
      save: jest.fn(async value => value),
    };
    repository.repo = {
      manager: {
        transaction: jest.fn(async callback =>
          callback({
            getRepository: () => entityRepository,
          })
        ),
      },
    };

    const saved = await repository.transition({
      state: 'challenged',
      lastValidationCode: 'CAPTCHA_REQUIRED',
    });

    expect(saved.stateChangedAt).toBe(stateChangedAt);
  });

  it('increments a persistent generation and rejects stale operation results', async () => {
    const repository = new DouyinCredentialRepository() as any;
    let current: any = {
      id: 'credential-id',
      slot: 'default',
      state: 'unknown',
      cookieNames: [],
      operationId: null,
      generation: 4,
    };
    const entityRepository = {
      createQueryBuilder: jest.fn(() => createInsertBuilder()),
      findOneOrFail: jest.fn(async () => current),
      create: jest.fn(value => value),
      save: jest.fn(async value => {
        current = value;
        return value;
      }),
    };
    repository.repo = {
      manager: {
        transaction: jest.fn(async callback =>
          callback({
            getRepository: () => entityRepository,
          })
        ),
      },
    };

    const started = await repository.beginOperation('operation-5', {
      state: 'validating',
    });
    expect(started.operation).toEqual({ id: 'operation-5', generation: 5 });

    await repository.invalidateOperation({
      state: 'expired',
      verifiedAt: null,
    });
    await expect(
      repository.transition(
        { state: 'valid', verifiedAt: new Date() },
        started.operation,
        true
      )
    ).resolves.toBeNull();
    expect(current.state).toBe('expired');
    expect(current.generation).toBe(6);
  });
});
