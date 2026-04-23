import {
  DanmakuColor,
  DanmakuMessage,
  DanmakuType,
} from '../interface/data';

type DouyuSttValue =
  | string
  | DouyuSttValue[]
  | {
      [key: string]: DouyuSttValue;
    };

type DouyuSttObject = {
  [key: string]: DouyuSttValue;
};

const DOUYU_DANMAKU_PORTS = [8501, 8502, 8503, 8504, 8505, 8506];
const DOUYU_MESSAGE_COLORS: Record<string, number> = {
  '0': DanmakuColor.WHITE,
  '1': 0xfefb5f,
  '2': 0x1e8880,
  '3': 0x7acdcb,
  '4': 0xff7c00,
  '5': 0x9b3794,
  '6': 0xff68b4,
  '7': DanmakuColor.WHITE,
};

export function getDouyuDanmakuUrl(): string {
  const port =
    DOUYU_DANMAKU_PORTS[
      Math.floor(Math.random() * DOUYU_DANMAKU_PORTS.length)
    ];
  return `wss://danmuproxy.douyu.com:${port}/`;
}

export function buildDouyuLoginPacket(roomId: string): Buffer {
  return encodeDouyuPacket(`type@=loginreq/roomid@=${escapeDouyuStt(roomId)}/`);
}

export function buildDouyuJoinGroupPacket(roomId: string): Buffer {
  return encodeDouyuPacket(
    `type@=joingroup/rid@=${escapeDouyuStt(roomId)}/gid@=-9999/`
  );
}

export function buildDouyuHeartbeatPacket(): Buffer {
  return encodeDouyuPacket('type@=mrkl/');
}

export function decodeDouyuPackets(buffer: Buffer): string[] {
  const messages: string[] = [];
  let offset = 0;

  while (offset + 12 <= buffer.length) {
    const packetLength = buffer.readUInt32LE(offset);
    if (packetLength < 8) {
      break;
    }

    const packetEnd = offset + 4 + packetLength;
    if (packetEnd > buffer.length) {
      break;
    }

    const bodyStart = offset + 12;
    const bodyEnd = packetEnd - 1;
    if (bodyStart < bodyEnd) {
      messages.push(buffer.toString('utf8', bodyStart, bodyEnd));
    }

    offset = packetEnd;
  }

  return messages;
}

export function parseDouyuDanmakuMessage(
  payload: string,
  timestamp: number,
  nextId: () => string
): DanmakuMessage | null {
  const parsed = deserializeDouyuStt(payload);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const message = parsed as DouyuSttObject;
  const type = toStringValue(message.type);
  if (!type) {
    return null;
  }

  const userId =
    toStringValue(message.uid) ||
    toStringValue(message.rid) ||
    toStringValue(message.cuid) ||
    '0';
  const username =
    toStringValue(message.nn) ||
    toStringValue(message.sn) ||
    toStringValue(message.uname) ||
    '匿名用户';
  const contentColor =
    DOUYU_MESSAGE_COLORS[toStringValue(message.col)] ?? DanmakuColor.WHITE;

  switch (type) {
    case 'chatmsg':
      return {
        id: nextId(),
        timestamp,
        type: DanmakuType.CHAT,
        userId,
        username,
        content: toStringValue(message.txt) || '',
        color: contentColor as DanmakuColor,
        contentColor,
        raw: message,
      };

    case 'dgb':
    case 'gdp':
    case 'spbc': {
      const giftId =
        toStringValue(message.gfid) ||
        toStringValue(message.gid) ||
        toStringValue(message.id) ||
        'unknown';
      const giftName =
        toStringValue(message.gfn) ||
        toStringValue(message.gn) ||
        `礼物#${giftId}`;
      const count = toNumberValue(
        message.gfcnt ?? message.gc ?? message.sl ?? message.dc ?? 1,
        1
      );

      return {
        id: nextId(),
        timestamp,
        type: DanmakuType.GIFT,
        userId,
        username,
        content: toStringValue(message.txt) || undefined,
        raw: message,
        gift: {
          giftId,
          giftName,
          count,
          price: 0,
          totalPrice: 0,
        },
      };
    }

    case 'uenter':
      return {
        id: nextId(),
        timestamp,
        type: DanmakuType.ENTER,
        userId,
        username,
        content:
          toStringValue(message.txt) || `${username || '用户'} 进入了直播间`,
        raw: message,
      };

    case 'rss':
      return {
        id: nextId(),
        timestamp,
        type: DanmakuType.NOTICE,
        userId: 'system',
        username: '系统',
        content: toStringValue(message.ss) === '1' ? '直播已开始' : '直播已结束',
        raw: message,
      };

    default:
      return null;
  }
}

function encodeDouyuPacket(payload: string): Buffer {
  const body = Buffer.from(`${payload}\0`, 'utf8');
  const packetLength = body.length + 8;
  const packet = Buffer.alloc(body.length + 12);

  packet.writeUInt32LE(packetLength, 0);
  packet.writeUInt32LE(packetLength, 4);
  packet.writeInt16LE(689, 8);
  packet.writeInt16LE(0, 10);
  body.copy(packet, 12);

  return packet;
}

function escapeDouyuStt(value: string): string {
  return value.replace(/@/g, '@A').replace(/\//g, '@S');
}

function unescapeDouyuStt(value: string): string {
  return value.replace(/@S/g, '/').replace(/@A/g, '@');
}

function deserializeDouyuStt(raw: string): DouyuSttValue {
  if (raw.includes('//')) {
    return raw
      .split('//')
      .filter(Boolean)
      .map(entry => deserializeDouyuStt(entry));
  }

  if (raw.includes('@=')) {
    return raw
      .split('/')
      .filter(Boolean)
      .reduce<DouyuSttObject>((result, segment) => {
        const delimiterIndex = segment.indexOf('@=');
        if (delimiterIndex <= 0) {
          return result;
        }

        const key = segment.slice(0, delimiterIndex);
        const value = segment.slice(delimiterIndex + 2);
        result[key] = value ? deserializeDouyuStt(value) : '';
        return result;
      }, {});
  }

  return unescapeDouyuStt(raw);
}

function toStringValue(value: DouyuSttValue | undefined): string {
  if (Array.isArray(value)) {
    return value.map(item => toStringValue(item)).join(',');
  }
  if (typeof value === 'object' && value !== null) {
    return '';
  }
  return value ? String(value) : '';
}

function toNumberValue(value: DouyuSttValue | number, fallback = 0): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  const parsed = Number(toStringValue(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}
