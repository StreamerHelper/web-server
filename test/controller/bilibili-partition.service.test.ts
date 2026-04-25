import { BilibiliPartitionService } from '../../src/service/bilibili-partition.service';

describe('BilibiliPartitionService', () => {
  it('uses the tid_v2 partition tree as the default selectable list', () => {
    const service = new BilibiliPartitionService() as any;

    const partitions = service.buildPartitions();
    const game = partitions.find(partition => partition.id === 1008);

    expect(game?.name).toBe('游戏');
    expect(game?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 2066,
          name: '单机主机类游戏',
        }),
        expect.objectContaining({
          id: 2070,
          name: 'MOBA游戏',
        }),
      ])
    );
  });

  it('filters and renames top-level groups with the creative-center list', () => {
    const service = new BilibiliPartitionService() as any;

    const partitions = service.buildPartitions([
      { id: 1008, name: '游戏专区' },
      { id: 1011, name: '人工智能' },
    ]);

    expect(partitions.map(partition => partition.id)).toEqual([1008, 1011]);
    expect(partitions[0].name).toBe('游戏专区');
    expect(partitions[0].children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 2066,
          name: '单机主机类游戏',
        }),
      ])
    );
  });

  it('resolves invalid selections to the default new partition', () => {
    const service = new BilibiliPartitionService() as any;

    expect(service.resolveHumanType2(2066)).toBe(2066);
    expect(service.resolveHumanType2(171)).toBe(2066);
    expect(service.resolveHumanType2(undefined)).toBe(2066);
  });
});
