import { BilibiliPartitionService } from '../../src/service/bilibili-partition.service';

describe('BilibiliPartitionService', () => {
  it('groups predicted partitions by human type when available', () => {
    const service = new BilibiliPartitionService() as any;

    const partitions = service.buildPartitions(
      [
        { id: 1002, name: '娱乐' },
        { id: 1008, name: '游戏' },
      ],
      [
        {
          id: 242,
          parent: 5,
          parent_name: '娱乐',
          name: '娱乐粉丝创作',
          show: true,
          rank: 40,
          human_type: { id: 1002 },
        },
        {
          id: 65,
          parent: 4,
          parent_name: '游戏',
          name: '网络游戏',
          show: true,
          rank: 30,
          human_type: { id: 1008 },
        },
      ]
    );

    expect(partitions).toEqual([
      {
        id: 1002,
        name: '娱乐',
        children: [{ id: 242, name: '娱乐粉丝创作' }],
      },
      {
        id: 1008,
        name: '游戏',
        children: [{ id: 65, name: '网络游戏' }],
      },
    ]);
  });

  it('falls back to legacy parent when human type is missing and ignores hidden items', () => {
    const service = new BilibiliPartitionService() as any;

    const partitions = service.buildPartitions([], [
      {
        id: 122,
        parent: 36,
        parent_name: '知识',
        name: '野生技能协会',
        show: true,
      },
      {
        id: 65,
        parent: 4,
        parent_name: '游戏',
        name: '网络游戏',
        show: false,
      },
    ]);

    expect(partitions).toEqual([
      {
        id: 36,
        name: '知识',
        children: [{ id: 122, name: '野生技能协会' }],
      },
    ]);
  });
});
