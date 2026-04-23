import * as crypto from 'crypto';
import { brotliDecompressSync, inflateSync } from 'zlib';
import {
  DanmakuColor,
  DanmakuMessage,
  DanmakuPosition,
  DanmakuType,
} from '../interface/data';

const BILIBILI_PACKET_HEADER_LENGTH = 16;
const BILIBILI_DEFAULT_UID = 0;
const BILIBILI_DEFAULT_PLATFORM = 'web';
const BILIBILI_DEFAULT_TYPE = 2;
const BILIBILI_DEFAULT_PROTOCOL_VERSION = 1;
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

export const BILIBILI_WS_OPERATION = {
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  USER_AUTHENTICATION: 7,
  CONNECT_SUCCESS: 8,
} as const;

export interface BilibiliDanmuHost {
  host: string;
  port: number;
  ws_port: number;
  wss_port: number;
}

export interface BilibiliDanmuInfo {
  token: string;
  host_list: BilibiliDanmuHost[];
}

export interface BilibiliDecodedPacket {
  protocol: number;
  operation: number;
  data: any;
}

export function buildBilibiliPacket(
  operation: number,
  body: string | Record<string, any> = ''
): Buffer {
  const serializedBody =
    typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const bodyBuffer = Buffer.from(serializedBody, 'utf-8');
  const header = Buffer.alloc(BILIBILI_PACKET_HEADER_LENGTH);

  header.writeUInt32BE(bodyBuffer.length + BILIBILI_PACKET_HEADER_LENGTH, 0);
  header.writeUInt16BE(BILIBILI_PACKET_HEADER_LENGTH, 4);
  header.writeUInt16BE(BILIBILI_DEFAULT_PROTOCOL_VERSION, 6);
  header.writeUInt32BE(operation, 8);
  header.writeUInt32BE(1, 12);

  return Buffer.concat([header, bodyBuffer]);
}

export function buildBilibiliAuthPacket(
  roomId: number,
  token: string,
  uid = BILIBILI_DEFAULT_UID,
  buvid?: string
): Buffer {
  return buildBilibiliPacket(BILIBILI_WS_OPERATION.USER_AUTHENTICATION, {
    uid,
    roomid: roomId,
    protover: 3,
    platform: BILIBILI_DEFAULT_PLATFORM,
    type: BILIBILI_DEFAULT_TYPE,
    key: token,
    ...(buvid ? { buvid } : {}),
  });
}

export function buildBilibiliHeartbeatPacket(): Buffer {
  return buildBilibiliPacket(BILIBILI_WS_OPERATION.HEARTBEAT);
}

export function decodeBilibiliPackets(buffer: Buffer): BilibiliDecodedPacket[] {
  const packets: BilibiliDecodedPacket[] = [];
  let offset = 0;

  while (offset + BILIBILI_PACKET_HEADER_LENGTH <= buffer.length) {
    const packetLength = buffer.readUInt32BE(offset);
    if (
      packetLength < BILIBILI_PACKET_HEADER_LENGTH ||
      offset + packetLength > buffer.length
    ) {
      throw new Error(`Invalid Bilibili packet length: ${packetLength}`);
    }

    const protocol = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);
    const body = buffer.subarray(
      offset + BILIBILI_PACKET_HEADER_LENGTH,
      offset + packetLength
    );

    if (protocol === 2) {
      packets.push(...decodeBilibiliPackets(inflateSync(body)));
    } else if (protocol === 3) {
      packets.push(...decodeBilibiliPackets(brotliDecompressSync(body)));
    } else if (
      protocol === 1 &&
      operation === BILIBILI_WS_OPERATION.HEARTBEAT_REPLY &&
      body.length === 4
    ) {
      packets.push({
        protocol,
        operation,
        data: body.readUInt32BE(0),
      });
    } else {
      packets.push({
        protocol,
        operation,
        data: parseBilibiliPacketBody(body),
      });
    }

    offset += packetLength;
  }

  return packets;
}

export function signBilibiliWbiUrl(
  url: URL,
  imgKey: string,
  subKey: string,
  timestamp = Math.floor(Date.now() / 1000)
): URL {
  const signedUrl = new URL(url);
  const mixinKey = getBilibiliMixinKey(imgKey + subKey);
  const params = new URLSearchParams(signedUrl.searchParams);

  params.set('wts', timestamp.toString());
  const sanitizedParams = new URLSearchParams();
  Array.from(params.entries())
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .forEach(([key, value]) => {
      sanitizedParams.set(key, sanitizeWbiValue(value));
    });

  const queryString = sanitizedParams.toString();
  const wRid = crypto
    .createHash('md5')
    .update(queryString + mixinKey)
    .digest('hex');

  sanitizedParams.set('w_rid', wRid);
  signedUrl.search = sanitizedParams.toString();

  return signedUrl;
}

export function parseBilibiliDanmakuCommand(
  payload: any,
  timestamp: number,
  nextId: () => string
): DanmakuMessage | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const cmd = normalizeBilibiliCommand(payload.cmd);
  switch (cmd) {
    case 'DANMU_MSG':
      return parseDanmuMessage(payload, timestamp, nextId);
    case 'LIVE_INTERACTIVE_GAME':
      return parseInteractiveGameMessage(payload, timestamp, nextId);
    case 'SEND_GIFT':
    case 'COMBO_SEND':
      return parseGiftMessage(payload, timestamp, nextId);
    case 'GUARD_BUY':
      return parseGuardBuyMessage(payload, timestamp, nextId);
    case 'SUPER_CHAT_MESSAGE':
    case 'SUPER_CHAT_MESSAGE_JPN':
      return parseSuperChatMessage(payload, timestamp, nextId);
    case 'INTERACT_WORD':
    case 'INTERACT_WORD_V2':
      return parseInteractMessage(payload, timestamp, nextId);
    case 'ENTRY_EFFECT':
      return parseEntryEffectMessage(payload, timestamp, nextId);
    case 'LIKE_INFO_V3_CLICK':
      return parseLikeMessage(payload, timestamp, nextId);
    case 'ROOM_CHANGE':
    case 'NOTICE_MSG':
    case 'COMMON_NOTICE_DANMAKU':
      return parseNoticeMessage(payload, timestamp, nextId);
    default:
      return null;
  }
}

function parseBilibiliPacketBody(body: Buffer): any {
  if (body.length === 0) {
    return '';
  }

  const text = body.toString('utf-8');
  if (!text) {
    return '';
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getBilibiliMixinKey(rawKey: string): string {
  return MIXIN_KEY_ENC_TAB.map(index => rawKey[index] || '')
    .join('')
    .slice(0, 32);
}

function sanitizeWbiValue(value: string): string {
  return value.replace(/[!'()*]/g, '');
}

function normalizeBilibiliCommand(cmd: unknown): string {
  return typeof cmd === 'string' ? cmd.split(':')[0] : '';
}

function parseDanmuMessage(
  payload: any,
  timestamp: number,
  nextId: () => string
): DanmakuMessage | null {
  const info = Array.isArray(payload.info) ? payload.info : null;
  if (!info) {
    return null;
  }

  const meta = Array.isArray(info[0]) ? info[0] : [];
  const text = typeof info[1] === 'string' ? info[1] : '';
  const user = Array.isArray(info[2]) ? info[2] : [];

  return {
    id: nextId(),
    timestamp,
    type: DanmakuType.CHAT,
    userId: String(user[0] ?? '0'),
    username: String(user[1] ?? ''),
    content: text,
    fontSize: toOptionalNumber(meta[2]),
    contentColor: toOptionalNumber(meta[3]),
    color: toOptionalDanmakuColor(meta[3]),
    position: toDanmakuPosition(meta[1]),
    raw: payload,
  };
}

function parseGiftMessage(
  payload: any,
  timestamp: number,
  nextId: () => string
): DanmakuMessage | null {
  const data = payload.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const count = toPositiveNumber(data.num) || 1;
  const coinType = String(data.coin_type || '').toLowerCase();
  const totalCoin = toPositiveNumber(data.total_coin);
  const singleCoin = toPositiveNumber(data.discount_price ?? data.price);
  const totalPrice = coinType === 'gold' ? totalCoin / 1000 : 0;
  const price = coinType === 'gold' ? singleCoin / 1000 : 0;

  return {
    id: nextId(),
    timestamp,
    type: DanmakuType.GIFT,
    userId: String(data.uid ?? '0'),
    username: String(data.uname ?? ''),
    content: `${String(data.giftName ?? data.gift_name ?? 'gift')} x${count}`,
    gift: {
      giftId: String(data.giftId ?? data.gift_id ?? ''),
      giftName: String(data.giftName ?? data.gift_name ?? ''),
      count,
      price,
      totalPrice: totalPrice || price * count,
    },
    raw: payload,
  };
}

function parseSuperChatMessage(
  payload: any,
  timestamp: number,
  nextId: () => string
): DanmakuMessage | null {
  const data = payload.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const userInfo = data.user_info || {};
  return {
    id: nextId(),
    timestamp,
    type: DanmakuType.SUPER_CHAT,
    userId: String(data.uid ?? userInfo.uid ?? '0'),
    username: String(userInfo.uname ?? data.user_name ?? ''),
    content: String(data.message ?? ''),
    superChat: {
      price: toPositiveNumber(data.price),
      backgroundColor: String(data.background_color || ''),
      borderColor: String(data.background_bottom_color || ''),
      backgroundIconUrl: data.background_icon ? String(data.background_icon) : undefined,
    },
    raw: payload,
  };
}

function parseInteractMessage(
  payload: any,
  timestamp: number,
  nextId: () => string
): DanmakuMessage | null {
  const data = resolveBilibiliInteractPayload(payload);
  if (!data || typeof data !== 'object') {
    return null;
  }

  const msgType = toPositiveNumber(data.msgType ?? data.msg_type);
  const type =
    msgType === 1
      ? DanmakuType.ENTER
      : msgType === 2
        ? DanmakuType.FOLLOW
        : msgType === 3
          ? DanmakuType.SHARE
          : DanmakuType.INTERACT;

  return {
    id: nextId(),
    timestamp,
    type,
    userId: String(data.uid ?? '0'),
    username: String(data.uname ?? data.username ?? ''),
    content: String(
      data.copy_writing ||
        data.copyWriting ||
        data.msg ||
        data.tailText ||
        ''
    ),
    raw: payload,
  };
}

function parseEntryEffectMessage(
  payload: any,
  timestamp: number,
  nextId: () => string
): DanmakuMessage | null {
  const data = payload.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const username = String(
    data.uinfo?.base?.name ?? data.uname ?? extractUsernameFromEntryEffect(data)
  );

  return {
    id: nextId(),
    timestamp,
    type: DanmakuType.ENTER,
    userId: String(data.uid ?? data.uinfo?.uid ?? '0'),
    username,
    content: String(data.copy_writing_v2 || data.copy_writing || ''),
    raw: payload,
  };
}

function parseInteractiveGameMessage(
  payload: any,
  timestamp: number,
  nextId: () => string
): DanmakuMessage | null {
  const data = payload.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  return {
    id: nextId(),
    timestamp,
    type: DanmakuType.CHAT,
    userId: String(data.uid ?? '0'),
    username: String(data.uname ?? data.username ?? ''),
    content: String(data.msg ?? data.content ?? ''),
    raw: payload,
  };
}

function parseGuardBuyMessage(
  payload: any,
  timestamp: number,
  nextId: () => string
): DanmakuMessage | null {
  const data = payload.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const count = toPositiveNumber(data.num) || 1;
  const totalPrice = toPositiveNumber(data.price);
  const unitPrice = count > 0 ? totalPrice / count : totalPrice;

  return {
    id: nextId(),
    timestamp,
    type: DanmakuType.GIFT,
    userId: String(data.uid ?? '0'),
    username: String(data.username ?? data.uname ?? ''),
    content: `${String(data.gift_name ?? '舰长')} x${count}`,
    gift: {
      giftId: String(data.gift_id ?? data.gift_name ?? 'guard'),
      giftName: String(data.gift_name ?? '舰长'),
      count,
      price: unitPrice,
      totalPrice,
    },
    raw: payload,
  };
}

function parseLikeMessage(
  payload: any,
  timestamp: number,
  nextId: () => string
): DanmakuMessage | null {
  const data = payload.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  return {
    id: nextId(),
    timestamp,
    type: DanmakuType.LIKE,
    userId: String(data.uid ?? '0'),
    username: String(data.uname ?? ''),
    content: String(data.uname ? `${data.uname} 点赞了直播间` : 'like'),
    raw: payload,
  };
}

function parseNoticeMessage(
  payload: any,
  timestamp: number,
  nextId: () => string
): DanmakuMessage {
  const data = payload.data;
  return {
    id: nextId(),
    timestamp,
    type: DanmakuType.NOTICE,
    userId: '0',
    username: 'system',
    content: String(
      data?.msg_common || data?.message || data?.room_name || payload.msg || payload.cmd
    ),
    raw: payload,
  };
}

function resolveBilibiliInteractPayload(payload: any): Record<string, any> | null {
  const cmd = normalizeBilibiliCommand(payload?.cmd);
  if (cmd === 'INTERACT_WORD_V2') {
    return decodeBilibiliInteractWordV2(payload);
  }

  return payload?.data && typeof payload.data === 'object' ? payload.data : null;
}

function decodeBilibiliInteractWordV2(
  payload: any
): Record<string, any> | null {
  const base64Payload = payload?.data?.pb;
  if (typeof base64Payload !== 'string' || base64Payload.length === 0) {
    return null;
  }

  try {
    const buffer = Buffer.from(base64Payload, 'base64');
    let offset = 0;
    const decoded: Record<string, any> = {};

    while (offset < buffer.length) {
      const tagResult = readProtoVarint(buffer, offset);
      const tag = tagResult.value;
      offset = tagResult.offset;

      const fieldNumber = Math.floor(tag / 8);
      const wireType = tag & 7;

      switch (fieldNumber) {
        case 1: {
          const value = readProtoVarint(buffer, offset);
          decoded.uid = value.value.toString();
          offset = value.offset;
          break;
        }
        case 2: {
          const value = readProtoString(buffer, offset);
          decoded.uname = value.value;
          offset = value.offset;
          break;
        }
        case 5: {
          const value = readProtoVarint(buffer, offset);
          decoded.msgType = Number(value.value);
          offset = value.offset;
          break;
        }
        case 6: {
          const value = readProtoVarint(buffer, offset);
          decoded.roomid = value.value.toString();
          offset = value.offset;
          break;
        }
        case 7: {
          const value = readProtoVarint(buffer, offset);
          decoded.timestamp = toSafeProtoNumber(value.value);
          offset = value.offset;
          break;
        }
        case 15: {
          const value = readProtoVarint(buffer, offset);
          decoded.triggerTime = toSafeProtoNumber(value.value);
          offset = value.offset;
          break;
        }
        case 18: {
          const value = readProtoString(buffer, offset);
          decoded.tailText = value.value;
          offset = value.offset;
          break;
        }
        default:
          offset = skipProtoField(buffer, offset, wireType);
          break;
      }
    }

    return decoded;
  } catch {
    return null;
  }
}

function extractUsernameFromEntryEffect(data: Record<string, any>): string {
  const rawText = String(data.copy_writing_v2 || data.copy_writing || '');
  const directMatch = rawText.match(/<%([^%>]+)%>/);
  if (directMatch?.[1]) {
    return directMatch[1];
  }

  return rawText.replace(/<%[^%>]+%>/g, '').replace(/\s*来了\s*/g, '').trim();
}

function readProtoVarint(
  buffer: Buffer,
  startOffset: number
): { value: number; offset: number } {
  let offset = startOffset;
  let result = 0;
  let shift = 0;

  while (offset < buffer.length) {
    const byte = buffer[offset];
    result += (byte & 0x7f) * 2 ** shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { value: result, offset };
    }

    shift += 7;
  }

  throw new Error('Unexpected end of protobuf varint');
}

function readProtoString(
  buffer: Buffer,
  startOffset: number
): { value: string; offset: number } {
  const lengthResult = readProtoVarint(buffer, startOffset);
  const length = Number(lengthResult.value);
  const start = lengthResult.offset;
  const end = start + length;

  return {
    value: buffer.subarray(start, end).toString('utf-8'),
    offset: end,
  };
}

function skipProtoField(
  buffer: Buffer,
  offset: number,
  wireType: number
): number {
  switch (wireType) {
    case 0:
      return readProtoVarint(buffer, offset).offset;
    case 1:
      return offset + 8;
    case 2: {
      const lengthResult = readProtoVarint(buffer, offset);
      return lengthResult.offset + Number(lengthResult.value);
    }
    case 5:
      return offset + 4;
    default:
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
}

function toSafeProtoNumber(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toPositiveNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toOptionalDanmakuColor(value: unknown): DanmakuColor | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (parsed as DanmakuColor) : undefined;
}

function toDanmakuPosition(value: unknown): DanmakuPosition | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  if (
    parsed === DanmakuPosition.SCROLL ||
    parsed === DanmakuPosition.BOTTOM ||
    parsed === DanmakuPosition.TOP ||
    parsed === DanmakuPosition.REVERSE ||
    parsed === DanmakuPosition.POSITION
  ) {
    return parsed as DanmakuPosition;
  }

  return undefined;
}
