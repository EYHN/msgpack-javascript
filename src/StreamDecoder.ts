import { prettyByte } from "./utils/prettyByte";
import { ExtensionCodec, ExtensionCodecType } from "./ExtensionCodec";
import { getInt64, getUint64, UINT32_MAX } from "./utils/int";
import { utf8DecodeJs, TEXT_DECODER_THRESHOLD, utf8DecodeTD } from "./utils/utf8";
import { CachedKeyDecoder, KeyDecoder } from "./CachedKeyDecoder";
import { DecodeError } from "./DecodeError";

const STATE_ARRAY = "array";
const STATE_MAP_KEY = "map_key";
const STATE_MAP_VALUE = "map_value";

type MapKeyType = string | number;

const isValidMapKeyType = (key: unknown): key is MapKeyType => {
  const keyType = typeof key;

  return keyType === "string" || keyType === "number";
};

type StackMapState = {
  type: typeof STATE_MAP_KEY | typeof STATE_MAP_VALUE;
  size: number;
  key: MapKeyType | null;
  readCount: number;
  map: Record<string, unknown>;
};

type StackArrayState = {
  type: typeof STATE_ARRAY;
  size: number;
  array: Array<unknown>;
  position: number;
};

type StackState = StackArrayState | StackMapState;

const HEAD_BYTE_REQUIRED = -1;

const EMPTY_VIEW = new DataView(new ArrayBuffer(0));

// IE11: Hack to support IE11.
// IE11: Drop this hack and just use RangeError when IE11 is obsolete.
export const DataViewIndexOutOfBoundsError: typeof Error = (() => {
  try {
    // IE11: The spec says it should throw RangeError,
    // IE11: but in IE11 it throws TypeError.
    EMPTY_VIEW.getInt8(0);
  } catch (e: any) {
    return e.constructor;
  }
  throw new Error("never reached");
})();

const sharedCachedKeyDecoder = new CachedKeyDecoder();

const MORE_DATA = new DataViewIndexOutOfBoundsError("Insufficient data");

export const DEFAULT_BUFFER_SIZE = 2048;

export class StreamDecoder<ContextType = undefined> {
  private headByte = HEAD_BYTE_REQUIRED;
  private readonly stack: Array<StackState> = [];
  private readonly readStream: AsyncIterator<Uint8Array, any, number | undefined>;
  private buffer: Uint8Array | null = null;

  public constructor(
    private readonly readIterable: AsyncIterable<Uint8Array>,
    private readonly extensionCodec: ExtensionCodecType<ContextType> = ExtensionCodec.defaultCodec as any,
    private readonly context: ContextType = undefined as any,
    private readonly maxStrLength = UINT32_MAX,
    private readonly maxBinLength = UINT32_MAX,
    private readonly maxArrayLength = UINT32_MAX,
    private readonly maxMapLength = UINT32_MAX,
    private readonly maxExtLength = UINT32_MAX,
    private readonly keyDecoder: KeyDecoder | null = sharedCachedKeyDecoder,
    private readonly bufferSize: number = DEFAULT_BUFFER_SIZE,
  ) {
    this.readStream = readIterable[Symbol.asyncIterator]();
  }

  private reinitializeState() {
    this.headByte = HEAD_BYTE_REQUIRED;
    this.stack.length = 0;

    // view, bytes, and pos will be re-initialized in setBuffer()
  }

  private createExtraByteError(): Error {
    return new RangeError(`Extra bytes found`);
  }

  /**
   * @throws {@link DecodeError}
   * @throws {@link RangeError}
   */
  public decode(): Promise<unknown> {
    this.reinitializeState();

    return this.doDecodeSync();
  }

  public async *decodeMulti(): AsyncGenerator<unknown> {
    this.reinitializeState();

    while (true) {
      yield await this.doDecodeSync();
    }
  }

  private async doDecodeSync() {
    DECODE: while (true) {
      const headByte = this.readHeadByteFromBuffer() ?? (await this.readHeadByte());
      let object: unknown;

      if (headByte >= 0xe0) {
        // negative fixint (111x xxxx) 0xe0 - 0xff
        object = headByte - 0x100;
      } else if (headByte < 0xc0) {
        if (headByte < 0x80) {
          // positive fixint (0xxx xxxx) 0x00 - 0x7f
          object = headByte;
        } else if (headByte < 0x90) {
          // fixmap (1000 xxxx) 0x80 - 0x8f
          const size = headByte - 0x80;
          if (size !== 0) {
            this.pushMapState(size);
            this.complete();
            continue DECODE;
          } else {
            object = {};
          }
        } else if (headByte < 0xa0) {
          // fixarray (1001 xxxx) 0x90 - 0x9f
          const size = headByte - 0x90;
          if (size !== 0) {
            this.pushArrayState(size);
            this.complete();
            continue DECODE;
          } else {
            object = [];
          }
        } else {
          // fixstr (101x xxxx) 0xa0 - 0xbf
          const byteLength = headByte - 0xa0;
          object = this.decodeUtf8StringFromBuffer(byteLength) ?? (await this.decodeUtf8String(byteLength));
        }
      } else if (headByte === 0xc0) {
        // nil
        object = null;
      } else if (headByte === 0xc2) {
        // false
        object = false;
      } else if (headByte === 0xc3) {
        // true
        object = true;
      } else if (headByte === 0xca) {
        // float 32
        object = this.readF32FromBuffer() ?? (await this.readF32());
      } else if (headByte === 0xcb) {
        // float 64
        object = this.readF64FromBuffer() ?? (await this.readF64());
      } else if (headByte === 0xcc) {
        // uint 8
        object = this.readU8FromBuffer() ?? (await this.readU8());
      } else if (headByte === 0xcd) {
        // uint 16
        object = this.readU16FromBuffer() ?? (await this.readU16());
      } else if (headByte === 0xce) {
        // uint 32
        object = this.readU32FromBuffer() ?? (await this.readU32());
      } else if (headByte === 0xcf) {
        // uint 64
        object = this.readU64FromBuffer() ?? (await this.readU64());
      } else if (headByte === 0xd0) {
        // int 8
        object = this.readI8FromBuffer() ?? (await this.readI8());
      } else if (headByte === 0xd1) {
        // int 16
        object = this.readI16FromBuffer() ?? (await this.readI16());
      } else if (headByte === 0xd2) {
        // int 32
        object = this.readI32FromBuffer() ?? (await this.readI32());
      } else if (headByte === 0xd3) {
        // int 64
        object = this.readI64FromBuffer() ?? (await this.readI64());
      } else if (headByte === 0xd9) {
        // str 8
        const byteLength = this.readU8FromBuffer() ?? (await this.readU8());
        object = this.decodeUtf8StringFromBuffer(byteLength) ?? (await this.decodeUtf8String(byteLength));
      } else if (headByte === 0xda) {
        // str 16
        const byteLength = this.readU16FromBuffer() ?? (await this.readU16());
        object = this.decodeUtf8StringFromBuffer(byteLength) ?? (await this.decodeUtf8String(byteLength));
      } else if (headByte === 0xdb) {
        // str 32
        const byteLength = this.readU32FromBuffer() ?? (await this.readU32());
        object = this.decodeUtf8StringFromBuffer(byteLength) ?? (await this.decodeUtf8String(byteLength));
      } else if (headByte === 0xdc) {
        // array 16
        const size = this.readU16FromBuffer() ?? (await this.readU16());
        if (size !== 0) {
          this.pushArrayState(size);
          this.complete();
          continue DECODE;
        } else {
          object = [];
        }
      } else if (headByte === 0xdd) {
        // array 32
        const size = this.readU32FromBuffer() ?? (await this.readU32());
        if (size !== 0) {
          this.pushArrayState(size);
          this.complete();
          continue DECODE;
        } else {
          object = [];
        }
      } else if (headByte === 0xde) {
        // map 16
        const size = this.readU16FromBuffer() ?? (await this.readU16());
        if (size !== 0) {
          this.pushMapState(size);
          this.complete();
          continue DECODE;
        } else {
          object = {};
        }
      } else if (headByte === 0xdf) {
        // map 32
        const size = this.readU32FromBuffer() ?? (await this.readU32());
        if (size !== 0) {
          this.pushMapState(size);
          this.complete();
          continue DECODE;
        } else {
          object = {};
        }
      } else if (headByte === 0xc4) {
        // bin 8
        const size = this.readU8FromBuffer() ?? (await this.readU8());
        object = await this.decodeBinary(size);
      } else if (headByte === 0xc5) {
        // bin 16
        const size = this.readU16FromBuffer() ?? (await this.readU16());
        object = await this.decodeBinary(size);
      } else if (headByte === 0xc6) {
        // bin 32
        const size = this.readU32FromBuffer() ?? (await this.readU32());
        object = await this.decodeBinary(size);
      } else if (headByte === 0xd4) {
        // fixext 1
        object = await this.decodeExtension(1);
      } else if (headByte === 0xd5) {
        // fixext 2
        object = await this.decodeExtension(2);
      } else if (headByte === 0xd6) {
        // fixext 4
        object = await this.decodeExtension(4);
      } else if (headByte === 0xd7) {
        // fixext 8
        object = await this.decodeExtension(8);
      } else if (headByte === 0xd8) {
        // fixext 16
        object = await this.decodeExtension(16);
      } else if (headByte === 0xc7) {
        // ext 8
        const size = this.readU8FromBuffer() ?? (await this.readU8());
        object = await this.decodeExtension(size);
      } else if (headByte === 0xc8) {
        // ext 16
        const size = this.readU16FromBuffer() ?? (await this.readU16());
        object = await this.decodeExtension(size);
      } else if (headByte === 0xc9) {
        // ext 32
        const size = this.readU32FromBuffer() ?? (await this.readU32());
        object = await this.decodeExtension(size);
      } else {
        throw new DecodeError(`Unrecognized type byte: ${prettyByte(headByte)}`);
      }

      this.complete();

      const stack = this.stack;
      while (stack.length > 0) {
        // arrays and maps
        const state = stack[stack.length - 1]!;
        if (state.type === STATE_ARRAY) {
          state.array[state.position] = object;
          state.position++;
          if (state.position === state.size) {
            stack.pop();
            object = state.array;
          } else {
            continue DECODE;
          }
        } else if (state.type === STATE_MAP_KEY) {
          if (!isValidMapKeyType(object)) {
            throw new DecodeError("The type of key must be string or number but " + typeof object);
          }
          if (object === "__proto__") {
            throw new DecodeError("The key __proto__ is not allowed");
          }

          state.key = object;
          state.type = STATE_MAP_VALUE;
          continue DECODE;
        } else {
          // it must be `state.type === State.MAP_VALUE` here

          state.map[state.key!] = object;
          state.readCount++;

          if (state.readCount === state.size) {
            stack.pop();
            object = state.map;
          } else {
            state.key = null;
            state.type = STATE_MAP_KEY;
            continue DECODE;
          }
        }
      }

      return object;
    }
  }

  private readHeadByteFromBuffer() {
    const b = this.readU8FromBuffer();
    if (b === null) {
      return null;
    }

    if (this.headByte === HEAD_BYTE_REQUIRED) {
      this.headByte = b;
    }

    return this.headByte;
  }

  private async readHeadByte() {
    if (this.headByte === HEAD_BYTE_REQUIRED) {
      this.headByte = await this.readU8();
    }

    return this.headByte;
  }

  private complete(): void {
    this.headByte = HEAD_BYTE_REQUIRED;
  }

  private pushMapState(size: number) {
    if (size > this.maxMapLength) {
      throw new DecodeError(`Max length exceeded: map length (${size}) > maxMapLengthLength (${this.maxMapLength})`);
    }

    this.stack.push({
      type: STATE_MAP_KEY,
      size,
      key: null,
      readCount: 0,
      map: {},
    });
  }

  private pushArrayState(size: number) {
    if (size > this.maxArrayLength) {
      throw new DecodeError(`Max length exceeded: array length (${size}) > maxArrayLength (${this.maxArrayLength})`);
    }

    this.stack.push({
      type: STATE_ARRAY,
      size,
      array: new Array<unknown>(size),
      position: 0,
    });
  }

  private decodeUtf8StringFromBuffer(byteLength: number) {
    if (byteLength > this.maxStrLength) {
      throw new DecodeError(
        `Max length exceeded: UTF-8 byte length (${byteLength}) > maxStrLength (${this.maxStrLength})`,
      );
    }

    const bytes = this.readBytesFromBuffer(byteLength);
    if (bytes === null) {
      return null;
    }
    let object: string;
    if (this.stateIsMapKey() && this.keyDecoder?.canBeCached(byteLength)) {
      object = this.keyDecoder.decode(bytes, 0, byteLength);
    } else if (byteLength > TEXT_DECODER_THRESHOLD) {
      object = utf8DecodeTD(bytes, 0, byteLength);
    } else {
      object = utf8DecodeJs(bytes, 0, byteLength);
    }
    return object;
  }

  private async decodeUtf8String(byteLength: number) {
    if (byteLength > this.maxStrLength) {
      throw new DecodeError(
        `Max length exceeded: UTF-8 byte length (${byteLength}) > maxStrLength (${this.maxStrLength})`,
      );
    }

    const bytes = await this.readBytes(byteLength);
    let object: string;
    if (this.stateIsMapKey() && this.keyDecoder?.canBeCached(byteLength)) {
      object = this.keyDecoder.decode(bytes, 0, byteLength);
    } else if (byteLength > TEXT_DECODER_THRESHOLD) {
      object = utf8DecodeTD(bytes, 0, byteLength);
    } else {
      object = utf8DecodeJs(bytes, 0, byteLength);
    }
    return object;
  }

  private stateIsMapKey(): boolean {
    if (this.stack.length > 0) {
      const state = this.stack[this.stack.length - 1]!;
      return state.type === STATE_MAP_KEY;
    }
    return false;
  }

  private async decodeBinary(byteLength: number) {
    if (byteLength > this.maxBinLength) {
      throw new DecodeError(`Max length exceeded: bin length (${byteLength}) > maxBinLength (${this.maxBinLength})`);
    }

    const object = await this.readBytes(byteLength);
    return object;
  }

  private async decodeExtension(size: number) {
    if (size > this.maxExtLength) {
      throw new DecodeError(`Max length exceeded: ext length (${size}) > maxExtLength (${this.maxExtLength})`);
    }

    const extType = await this.readI8();
    const data = await this.decodeBinary(size);
    return this.extensionCodec.decode(data, extType, this.context);
  }

  private async readU8() {
    const data = await this.readBytes(1);
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint8(0);
    return value;
  }

  private async readI8() {
    const data = await this.readBytes(1);
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt8(0);
    return value;
  }

  private async readU16() {
    const data = await this.readBytes(2);
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(0);
    return value;
  }

  private async readI16() {
    const data = await this.readBytes(2);
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt16(0);
    return value;
  }

  private async readU32() {
    const data = await this.readBytes(4);
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
    return value;
  }

  private async readI32() {
    const data = await this.readBytes(4);
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(0);
    return value;
  }

  private async readU64() {
    const data = await this.readBytes(8);
    const value = getUint64(new DataView(data.buffer, data.byteOffset, data.byteLength), 0);
    return value;
  }

  private async readI64() {
    const data = await this.readBytes(8);
    const value = getInt64(new DataView(data.buffer, data.byteOffset, data.byteLength), 0);
    return value;
  }

  private async readF32() {
    const data = await this.readBytes(4);
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat32(0);
    return value;
  }

  private async readF64() {
    const data = await this.readBytes(8);
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(0);
    return value;
  }

  private readU8FromBuffer() {
    const data = this.readBytesFromBuffer(1);
    if (!data) {
      return null;
    }
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint8(0);
    return value;
  }

  private readI8FromBuffer() {
    const data = this.readBytesFromBuffer(1);
    if (!data) {
      return null;
    }
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt8(0);
    return value;
  }

  private readU16FromBuffer() {
    const data = this.readBytesFromBuffer(2);
    if (!data) {
      return null;
    }
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(0);
    return value;
  }

  private readI16FromBuffer() {
    const data = this.readBytesFromBuffer(2);
    if (!data) {
      return null;
    }
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt16(0);
    return value;
  }

  private readU32FromBuffer() {
    const data = this.readBytesFromBuffer(4);
    if (!data) {
      return null;
    }
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
    return value;
  }

  private readI32FromBuffer() {
    const data = this.readBytesFromBuffer(4);
    if (!data) {
      return null;
    }
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(0);
    return value;
  }

  private readU64FromBuffer() {
    const data = this.readBytesFromBuffer(8);
    if (!data) {
      return null;
    }
    const value = getUint64(new DataView(data.buffer, data.byteOffset, data.byteLength), 0);
    return value;
  }

  private readI64FromBuffer() {
    const data = this.readBytesFromBuffer(8);
    if (!data) {
      return null;
    }
    const value = getInt64(new DataView(data.buffer, data.byteOffset, data.byteLength), 0);
    return value;
  }

  private readF32FromBuffer() {
    const data = this.readBytesFromBuffer(4);
    if (!data) {
      return null;
    }
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat32(0);
    return value;
  }

  private readF64FromBuffer() {
    const data = this.readBytesFromBuffer(8);
    if (!data) {
      return null;
    }
    const value = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(0);
    return value;
  }

  private readBytesFromBuffer(length: number): Uint8Array | null {
    if (this.buffer && this.buffer.length >= length) {
      const result = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      return result;
    }
    return null;
  }

  private async readBytes(length: number) {
    if (this.buffer && length <= this.buffer.length) {
      const result = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      return result;
    } else {
      const hasData = this.buffer?.length ?? 0;
      const needData = length - hasData;
      const result = new Uint8Array(length);
      if (this.buffer) {
        result.set(this.buffer, 0);
      }
      if (needData < this.bufferSize) {
        const next = await this.readToBuffer(this.bufferSize);
        if (next.length < needData) {
          throw MORE_DATA;
        }
        result.set(next.subarray(0, needData), hasData);
        this.buffer = this.buffer!.subarray(needData);
      } else {
        const next = await this.readToBuffer(needData);
        if (next.length < needData) {
          throw MORE_DATA;
        }
        result.set(next.subarray(0, needData), hasData);
        this.buffer = this.buffer!.subarray(needData);
      }
      return result;
    }
  }

  private async readToBuffer(length: number) {
    const bytes: Array<Uint8Array> = [];
    let size = 0;
    while (size < length) {
      const result = await this.readStream.next(this.bufferSize);
      if (!result.done) {
        bytes.push(result.value);
        size += result.value.length;
      } else {
        break;
      }
    }
    if (bytes.length == 1) {
      this.buffer = bytes[0]!;
      return bytes[0]!;
    }
    this.buffer = new Uint8Array(size);
    let pos = 0;
    for (const chunk of bytes) {
      this.buffer.set(chunk, pos);
      pos += chunk.length;
    }
    return this.buffer;
  }
}
