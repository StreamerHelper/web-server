import {
  DanmakuColor,
  DanmakuMessage,
  DanmakuType,
} from '../interface/data';

const HUYA_DANMAKU_URL = 'wss://cdnws.api.huya.com/';
const HUYA_HEARTBEAT_HEX =
  '00031d0000690000006910032c3c4c56086f6e6c696e657569660f4f6e557365724865617274426561747d00003c0800010604745265711d00002f0a0a0c1600260036076164725f77617046000b1203aef00f2203aef00f3c426d5202605c60017c82000bb01f9cac0b8c980ca80c20';

enum HuyaJceType {
  INT8 = 0,
  INT16 = 1,
  INT32 = 2,
  INT64 = 3,
  FLOAT = 4,
  DOUBLE = 5,
  STRING1 = 6,
  STRING4 = 7,
  MAP = 8,
  LIST = 9,
  STRUCT_BEGIN = 10,
  STRUCT_END = 11,
  ZERO = 12,
  SIMPLE_LIST = 13,
}

interface HuyaWebSocketCommand {
  iCmdType: number;
  vData: Buffer;
}

interface HuyaPushMessage {
  iUri: number;
  sMsg: Buffer;
}

interface HuyaSenderInfo {
  lUid: number;
  sNickName: string;
}

interface HuyaFormat {
  iFontColor: number;
  iFontSize: number;
}

interface HuyaMessageNotice {
  tUserInfo: HuyaSenderInfo;
  sContent: string;
  tFormat: HuyaFormat;
  tBulletFormat: HuyaFormat;
}

interface HuyaGiftPacket {
  iItemType: number;
  iItemCount: number;
  lPresenterUid: number;
  lSenderUid: number;
  sSenderNick: string;
  sSendContent: string;
}

interface HuyaFieldHead {
  type: HuyaJceType;
  tag: number;
  size: number;
}

export function getHuyaDanmakuUrl(): string {
  return HUYA_DANMAKU_URL;
}

export function getHuyaHeartbeatPacket(): Buffer {
  return Buffer.from(HUYA_HEARTBEAT_HEX, 'hex');
}

export function peekHuyaCommandType(buffer: Buffer): number {
  return parseHuyaWebSocketCommand(buffer).iCmdType;
}

export function extractHuyaUidFromRoomPage(html: string): number | null {
  const patterns = [
    /"uid":"?(\d+)"?/,
    /"lPresenterUid":(\d+)/,
    /"lp":(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
  }

  return null;
}

export function buildHuyaRegisterPacket(uid: number): Buffer {
  const payload = Buffer.concat([
    encodeInt64Field(0, uid),
    encodeBooleanField(1, false),
    encodeStringField(2, ''),
    encodeStringField(3, ''),
    encodeInt64Field(4, 0),
    encodeInt64Field(5, 0),
    encodeInt64Field(6, uid),
    encodeInt64Field(7, 3),
  ]);

  return buildHuyaWebSocketCommand(1, payload);
}

export function buildHuyaWebSocketCommand(
  iCmdType: number,
  vData: Buffer
): Buffer {
  return Buffer.concat([encodeInt32Field(0, iCmdType), encodeBytesField(1, vData)]);
}

export function buildHuyaPushMessageCommand(
  iUri: number,
  payload: Buffer
): Buffer {
  const pushMessage = Buffer.concat([
    encodeInt32Field(0, 0),
    encodeInt64Field(1, iUri),
    encodeBytesField(2, payload),
    encodeInt32Field(3, 0),
  ]);

  return buildHuyaWebSocketCommand(7, pushMessage);
}

export function buildHuyaMessageNoticePayload(params: {
  userId: number;
  username: string;
  content: string;
  fontColor?: number;
  fontSize?: number;
}): Buffer {
  const userInfo = encodeStructField(
    0,
    Buffer.concat([
      encodeInt64Field(0, params.userId),
      encodeInt64Field(1, 0),
      encodeStringField(2, params.username),
      encodeInt32Field(3, 0),
    ])
  );
  const contentFormat = encodeStructField(
    5,
    Buffer.concat([
      encodeInt32Field(0, params.fontColor ?? DanmakuColor.WHITE),
      encodeInt32Field(1, params.fontSize ?? 4),
      encodeInt32Field(2, 0),
    ])
  );
  const bulletFormat = encodeStructField(
    6,
    Buffer.concat([
      encodeInt32Field(0, params.fontColor ?? DanmakuColor.WHITE),
      encodeInt32Field(1, params.fontSize ?? 4),
      encodeInt32Field(2, 0),
      encodeInt32Field(3, 1),
      encodeInt32Field(4, 0),
    ])
  );

  return Buffer.concat([
    userInfo,
    encodeInt64Field(1, 0),
    encodeInt64Field(2, 0),
    encodeStringField(3, params.content),
    encodeInt32Field(4, 0),
    contentFormat,
    bulletFormat,
    encodeInt32Field(7, 0),
  ]);
}

export function buildHuyaGiftPayload(params: {
  itemType: number;
  count: number;
  presenterUid?: number;
  senderUid: number;
  senderNick: string;
  sendContent?: string;
}): Buffer {
  return Buffer.concat([
    encodeInt32Field(0, params.itemType),
    encodeStringField(1, ''),
    encodeInt32Field(2, params.count),
    encodeInt64Field(3, params.presenterUid ?? 0),
    encodeInt64Field(4, params.senderUid),
    encodeStringField(5, ''),
    encodeStringField(6, params.senderNick),
    encodeStringField(7, params.sendContent || ''),
    encodeInt32Field(8, 0),
    encodeInt32Field(9, 0),
    encodeInt32Field(10, 0),
    encodeInt32Field(11, 0),
    encodeInt32Field(12, 0),
    encodeInt32Field(13, 0),
    encodeStringField(14, ''),
    encodeStringField(15, ''),
    encodeInt32Field(16, 0),
    encodeStringField(17, ''),
    encodeBooleanField(18, false),
    encodeInt32Field(19, 0),
  ]);
}

export function decodeHuyaDanmakuMessages(
  buffer: Buffer,
  timestamp: number,
  nextId: () => string
): DanmakuMessage[] {
  const messages: DanmakuMessage[] = [];
  const command = parseHuyaWebSocketCommand(buffer);

  if (command.iCmdType !== 7) {
    return messages;
  }

  const pushMessage = parseHuyaPushMessage(command.vData);

  if (pushMessage.iUri === 1400) {
    const notice = parseHuyaMessageNotice(pushMessage.sMsg);
    const contentColor =
      notice.tBulletFormat.iFontColor >= 0
        ? notice.tBulletFormat.iFontColor
        : notice.tFormat.iFontColor >= 0
          ? notice.tFormat.iFontColor
          : DanmakuColor.WHITE;

    if (notice.sContent) {
      messages.push({
        id: nextId(),
        timestamp,
        type: DanmakuType.CHAT,
        userId: String(notice.tUserInfo.lUid || 0),
        username: notice.tUserInfo.sNickName || '匿名用户',
        content: notice.sContent,
        color: contentColor as DanmakuColor,
        contentColor,
        fontSize:
          notice.tBulletFormat.iFontSize || notice.tFormat.iFontSize || 4,
        raw: notice,
      });
    }
  }

  if (pushMessage.iUri === 6501) {
    const gift = parseHuyaGiftPacket(pushMessage.sMsg);
    messages.push({
      id: nextId(),
      timestamp,
      type: DanmakuType.GIFT,
      userId: String(gift.lSenderUid || 0),
      username: gift.sSenderNick || '匿名用户',
      content: gift.sSendContent || undefined,
      raw: gift,
      gift: {
        giftId: String(gift.iItemType || 'unknown'),
        giftName: `礼物#${gift.iItemType || 'unknown'}`,
        count: gift.iItemCount || 1,
        price: 0,
        totalPrice: 0,
      },
    });
  }

  return messages;
}

function parseHuyaWebSocketCommand(buffer: Buffer): HuyaWebSocketCommand {
  let iCmdType = 0;
  let vData = Buffer.alloc(0);
  let offset = 0;

  while (offset < buffer.length) {
    const head = readFieldHead(buffer, offset);
    offset += head.size;

    if (head.type === HuyaJceType.STRUCT_END) {
      break;
    }

    if (head.tag === 0) {
      const parsed = readNumericValue(buffer, offset, head.type);
      iCmdType = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 1) {
      const parsed = readBytesValue(buffer, offset, head.type);
      vData = parsed.value;
      offset = parsed.offset;
      continue;
    }

    offset = skipFieldValue(buffer, offset, head.type);
  }

  return { iCmdType, vData };
}

function parseHuyaPushMessage(buffer: Buffer): HuyaPushMessage {
  let iUri = 0;
  let sMsg = Buffer.alloc(0);
  let offset = 0;

  while (offset < buffer.length) {
    const head = readFieldHead(buffer, offset);
    offset += head.size;

    if (head.type === HuyaJceType.STRUCT_END) {
      break;
    }

    if (head.tag === 1) {
      const parsed = readNumericValue(buffer, offset, head.type);
      iUri = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 2) {
      const parsed = readBytesValue(buffer, offset, head.type);
      sMsg = parsed.value;
      offset = parsed.offset;
      continue;
    }

    offset = skipFieldValue(buffer, offset, head.type);
  }

  return { iUri, sMsg };
}

function parseHuyaMessageNotice(buffer: Buffer): HuyaMessageNotice {
  const notice: HuyaMessageNotice = {
    tUserInfo: {
      lUid: 0,
      sNickName: '',
    },
    sContent: '',
    tFormat: {
      iFontColor: DanmakuColor.WHITE,
      iFontSize: 4,
    },
    tBulletFormat: {
      iFontColor: DanmakuColor.WHITE,
      iFontSize: 4,
    },
  };

  let offset = 0;
  while (offset < buffer.length) {
    const head = readFieldHead(buffer, offset);
    offset += head.size;

    if (head.type === HuyaJceType.STRUCT_END) {
      break;
    }

    if (head.tag === 0 && head.type === HuyaJceType.STRUCT_BEGIN) {
      const parsed = parseHuyaSenderInfo(buffer, offset);
      notice.tUserInfo = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 3) {
      const parsed = readStringValue(buffer, offset, head.type);
      notice.sContent = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 5 && head.type === HuyaJceType.STRUCT_BEGIN) {
      const parsed = parseHuyaFormat(buffer, offset);
      notice.tFormat = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 6 && head.type === HuyaJceType.STRUCT_BEGIN) {
      const parsed = parseHuyaFormat(buffer, offset);
      notice.tBulletFormat = parsed.value;
      offset = parsed.offset;
      continue;
    }

    offset = skipFieldValue(buffer, offset, head.type);
  }

  return notice;
}

function parseHuyaSenderInfo(
  buffer: Buffer,
  offset: number
): { value: HuyaSenderInfo; offset: number } {
  const value: HuyaSenderInfo = {
    lUid: 0,
    sNickName: '',
  };

  while (offset < buffer.length) {
    const head = readFieldHead(buffer, offset);
    offset += head.size;

    if (head.type === HuyaJceType.STRUCT_END) {
      break;
    }

    if (head.tag === 0) {
      const parsed = readNumericValue(buffer, offset, head.type);
      value.lUid = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 2) {
      const parsed = readStringValue(buffer, offset, head.type);
      value.sNickName = parsed.value;
      offset = parsed.offset;
      continue;
    }

    offset = skipFieldValue(buffer, offset, head.type);
  }

  return { value, offset };
}

function parseHuyaFormat(
  buffer: Buffer,
  offset: number
): { value: HuyaFormat; offset: number } {
  const value: HuyaFormat = {
    iFontColor: DanmakuColor.WHITE,
    iFontSize: 4,
  };

  while (offset < buffer.length) {
    const head = readFieldHead(buffer, offset);
    offset += head.size;

    if (head.type === HuyaJceType.STRUCT_END) {
      break;
    }

    if (head.tag === 0) {
      const parsed = readNumericValue(buffer, offset, head.type);
      value.iFontColor = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 1) {
      const parsed = readNumericValue(buffer, offset, head.type);
      value.iFontSize = parsed.value;
      offset = parsed.offset;
      continue;
    }

    offset = skipFieldValue(buffer, offset, head.type);
  }

  return { value, offset };
}

function parseHuyaGiftPacket(buffer: Buffer): HuyaGiftPacket {
  const value: HuyaGiftPacket = {
    iItemType: 0,
    iItemCount: 1,
    lPresenterUid: 0,
    lSenderUid: 0,
    sSenderNick: '',
    sSendContent: '',
  };
  let offset = 0;

  while (offset < buffer.length) {
    const head = readFieldHead(buffer, offset);
    offset += head.size;

    if (head.type === HuyaJceType.STRUCT_END) {
      break;
    }

    if (head.tag === 0) {
      const parsed = readNumericValue(buffer, offset, head.type);
      value.iItemType = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 2) {
      const parsed = readNumericValue(buffer, offset, head.type);
      value.iItemCount = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 3) {
      const parsed = readNumericValue(buffer, offset, head.type);
      value.lPresenterUid = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 4) {
      const parsed = readNumericValue(buffer, offset, head.type);
      value.lSenderUid = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 6) {
      const parsed = readStringValue(buffer, offset, head.type);
      value.sSenderNick = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (head.tag === 7) {
      const parsed = readStringValue(buffer, offset, head.type);
      value.sSendContent = parsed.value;
      offset = parsed.offset;
      continue;
    }

    offset = skipFieldValue(buffer, offset, head.type);
  }

  return value;
}

function encodeInt32Field(tag: number, value: number): Buffer {
  if (!value) {
    return encodeHead(HuyaJceType.ZERO, tag);
  }

  const body = Buffer.alloc(4);
  body.writeInt32BE(value, 0);
  return Buffer.concat([encodeHead(HuyaJceType.INT32, tag), body]);
}

function encodeInt64Field(tag: number, value: number): Buffer {
  if (!value) {
    return encodeHead(HuyaJceType.ZERO, tag);
  }

  const body = Buffer.alloc(8);
  const positiveValue = Math.trunc(Math.abs(value));
  const high = Math.floor(positiveValue / 0x100000000);
  const low = positiveValue % 0x100000000;
  body.writeInt32BE(value < 0 ? -high : high, 0);
  body.writeUInt32BE(low >>> 0, 4);
  return Buffer.concat([encodeHead(HuyaJceType.INT64, tag), body]);
}

function encodeBooleanField(tag: number, value: boolean): Buffer {
  return Buffer.concat([
    encodeHead(HuyaJceType.INT8, tag),
    Buffer.from([value ? 1 : 0]),
  ]);
}

function encodeStringField(tag: number, value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  if (body.length < 256) {
    return Buffer.concat([
      encodeHead(HuyaJceType.STRING1, tag),
      Buffer.from([body.length]),
      body,
    ]);
  }

  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([
    encodeHead(HuyaJceType.STRING4, tag),
    length,
    body,
  ]);
}

function encodeBytesField(tag: number, value: Buffer): Buffer {
  return Buffer.concat([
    encodeHead(HuyaJceType.SIMPLE_LIST, tag),
    encodeHead(HuyaJceType.INT8, 0),
    encodeInt32Field(0, value.length),
    value,
  ]);
}

function encodeStructField(tag: number, value: Buffer): Buffer {
  return Buffer.concat([
    encodeHead(HuyaJceType.STRUCT_BEGIN, tag),
    value,
    encodeHead(HuyaJceType.STRUCT_END, 0),
  ]);
}

function encodeHead(type: HuyaJceType, tag: number): Buffer {
  if (tag < 15) {
    return Buffer.from([(tag << 4) | type]);
  }

  return Buffer.from([(15 << 4) | type, tag]);
}

function readFieldHead(buffer: Buffer, offset: number): HuyaFieldHead {
  const first = buffer[offset];
  const type = first & 0x0f;
  const tag = first >> 4;

  if (tag === 15) {
    return {
      type,
      tag: buffer[offset + 1],
      size: 2,
    };
  }

  return {
    type,
    tag,
    size: 1,
  };
}

function readNumericValue(
  buffer: Buffer,
  offset: number,
  type: HuyaJceType
): { value: number; offset: number } {
  switch (type) {
    case HuyaJceType.ZERO:
      return { value: 0, offset };
    case HuyaJceType.INT8:
      return { value: buffer.readInt8(offset), offset: offset + 1 };
    case HuyaJceType.INT16:
      return { value: buffer.readInt16BE(offset), offset: offset + 2 };
    case HuyaJceType.INT32:
      return { value: buffer.readInt32BE(offset), offset: offset + 4 };
    case HuyaJceType.INT64: {
      const high = buffer.readInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      return {
        value: high * 0x100000000 + low,
        offset: offset + 8,
      };
    }
    default:
      throw new Error(`Unsupported numeric JCE type: ${type}`);
  }
}

function readStringValue(
  buffer: Buffer,
  offset: number,
  type: HuyaJceType
): { value: string; offset: number } {
  if (type === HuyaJceType.STRING1) {
    const length = buffer.readUInt8(offset);
    const start = offset + 1;
    return {
      value: buffer.toString('utf8', start, start + length),
      offset: start + length,
    };
  }

  if (type === HuyaJceType.STRING4) {
    const length = buffer.readUInt32BE(offset);
    const start = offset + 4;
    return {
      value: buffer.toString('utf8', start, start + length),
      offset: start + length,
    };
  }

  throw new Error(`Unsupported string JCE type: ${type}`);
}

function readBytesValue(
  buffer: Buffer,
  offset: number,
  type: HuyaJceType
): { value: Buffer; offset: number } {
  if (type !== HuyaJceType.SIMPLE_LIST) {
    throw new Error(`Unsupported bytes JCE type: ${type}`);
  }

  const itemType = readFieldHead(buffer, offset);
  offset += itemType.size;
  if (itemType.type !== HuyaJceType.INT8) {
    throw new Error('Huya simple list is not a byte list');
  }

  const countHead = readFieldHead(buffer, offset);
  offset += countHead.size;
  const count = readNumericValue(buffer, offset, countHead.type);
  offset = count.offset;

  return {
    value: buffer.slice(offset, offset + count.value),
    offset: offset + count.value,
  };
}

function skipFieldValue(
  buffer: Buffer,
  offset: number,
  type: HuyaJceType
): number {
  switch (type) {
    case HuyaJceType.ZERO:
      return offset;
    case HuyaJceType.INT8:
      return offset + 1;
    case HuyaJceType.INT16:
      return offset + 2;
    case HuyaJceType.INT32:
    case HuyaJceType.FLOAT:
      return offset + 4;
    case HuyaJceType.INT64:
    case HuyaJceType.DOUBLE:
      return offset + 8;
    case HuyaJceType.STRING1:
      return offset + 1 + buffer.readUInt8(offset);
    case HuyaJceType.STRING4:
      return offset + 4 + buffer.readUInt32BE(offset);
    case HuyaJceType.SIMPLE_LIST: {
      const itemType = readFieldHead(buffer, offset);
      offset += itemType.size;
      const countHead = readFieldHead(buffer, offset);
      offset += countHead.size;
      const count = readNumericValue(buffer, offset, countHead.type);
      return count.offset + count.value;
    }
    case HuyaJceType.STRUCT_BEGIN: {
      while (offset < buffer.length) {
        const head = readFieldHead(buffer, offset);
        offset += head.size;
        if (head.type === HuyaJceType.STRUCT_END) {
          break;
        }
        offset = skipFieldValue(buffer, offset, head.type);
      }
      return offset;
    }
    case HuyaJceType.MAP: {
      const countHead = readFieldHead(buffer, offset);
      offset += countHead.size;
      const count = readNumericValue(buffer, offset, countHead.type);
      offset = count.offset;
      for (let i = 0; i < count.value * 2; i += 1) {
        const head = readFieldHead(buffer, offset);
        offset += head.size;
        offset = skipFieldValue(buffer, offset, head.type);
      }
      return offset;
    }
    case HuyaJceType.LIST: {
      const countHead = readFieldHead(buffer, offset);
      offset += countHead.size;
      const count = readNumericValue(buffer, offset, countHead.type);
      offset = count.offset;
      for (let i = 0; i < count.value; i += 1) {
        const head = readFieldHead(buffer, offset);
        offset += head.size;
        offset = skipFieldValue(buffer, offset, head.type);
      }
      return offset;
    }
    case HuyaJceType.STRUCT_END:
      return offset;
    default:
      throw new Error(`Unsupported JCE type for skipping: ${type}`);
  }
}
