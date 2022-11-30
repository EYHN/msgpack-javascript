import { utf8EncodeJs, utf8Count, TEXT_ENCODER_THRESHOLD, utf8EncodeTE } from "./utils/utf8";
import { ExtensionCodec, ExtensionCodecType } from "./ExtensionCodec";
import { setInt64, setUint64 } from "./utils/int";
import { ensureUint8Array } from "./utils/typedArrays";
import type { ExtData } from "./ExtData";

export const DEFAULT_MAX_DEPTH = 100;
export const DEFAULT_BUFFER_SIZE = 2048;

export class StreamEncoder<ContextType = undefined> {
  private view = new DataView(new ArrayBuffer(2048));
  private bytes = new Uint8Array(this.view.buffer);

  public constructor(
    private readonly extensionCodec: ExtensionCodecType<ContextType> = ExtensionCodec.defaultCodec as any,
    private readonly context: ContextType = undefined as any,
    private readonly maxDepth = DEFAULT_MAX_DEPTH,
    private readonly bufferSize = DEFAULT_BUFFER_SIZE,
    private readonly sortKeys = false,
    private readonly forceFloat32 = false,
    private readonly ignoreUndefined = false,
    private readonly forceIntegerToFloat = false,
  ) {}

  public *encode(object: unknown): Iterable<Uint8Array> {
    const buffer = new Uint8Array(this.bufferSize);
    let pos = 0;

    for (let chunk of this.doEncode(object, 1)) {
      if (chunk.length >= buffer.length) {
        if (pos >= 0) {
          yield buffer.slice(0, pos);
        }
        pos = 0;
        yield chunk.slice();
      } else {
        while (chunk.length > 0) {
          const readSize = Math.min(buffer.length - pos, chunk.length);
          const read = chunk.subarray(0, readSize);
          buffer.set(read, pos);
          pos += read.length;
          if (pos === buffer.length) {
            yield buffer.slice();
            pos = 0;
          }
          chunk = chunk.subarray(readSize, chunk.length);
        }
      }
    }

    if (pos >= 0) {
      yield buffer.subarray(0, pos);
    }
  }

  private doEncode(object: unknown, depth: number): Iterable<Uint8Array> {
    if (depth > this.maxDepth) {
      throw new Error(`Too deep objects in depth ${depth}`);
    }

    if (object == null) {
      return this.encodeNil();
    } else if (typeof object === "boolean") {
      return this.encodeBoolean(object);
    } else if (typeof object === "number") {
      return this.encodeNumber(object);
    } else if (typeof object === "string") {
      return this.encodeString(object);
    } else {
      return this.encodeObject(object, depth);
    }
  }

  private ensureBufferSizeToWrite(sizeToWrite: number) {
    if (this.view.byteLength < sizeToWrite) {
      this.resizeBuffer(sizeToWrite * 2);
    }
  }

  private resizeBuffer(newSize: number) {
    const newBuffer = new ArrayBuffer(newSize);
    const newBytes = new Uint8Array(newBuffer);
    const newView = new DataView(newBuffer);

    this.view = newView;
    this.bytes = newBytes;
  }

  private encodeNil() {
    return this.writeU8(0xc0);
  }

  private encodeBoolean(object: boolean) {
    if (object === false) {
      return this.writeU8(0xc2);
    } else {
      return this.writeU8(0xc3);
    }
  }

  private encodeNumber(object: number) {
    if (Number.isSafeInteger(object) && !this.forceIntegerToFloat) {
      if (object >= 0) {
        if (object < 0x80) {
          // positive fixint
          return this.writeU8(object);
        } else if (object < 0x100) {
          // uint 8
          return this.writeU8U8(0xcc, object);
        } else if (object < 0x10000) {
          // uint 16
          return this.writeU8U16(0xcd, object);
        } else if (object < 0x100000000) {
          // uint 32
          return this.writeU8U32(0xce, object);
        } else {
          // uint 64
          return this.writeU8U64(0xcf, object);
        }
      } else {
        if (object >= -0x20) {
          // negative fixint
          return this.writeU8(0xe0 | (object + 0x20));
        } else if (object >= -0x80) {
          // int 8
          return this.writeU8I8(0xd0, object);
        } else if (object >= -0x8000) {
          // int 16
          return this.writeU8I16(0xd1, object);
        } else if (object >= -0x80000000) {
          // int 32
          return this.writeU8I32(0xd2, object);
        } else {
          // int 64
          return this.writeU8I64(0xd3, object);
        }
      }
    } else {
      // non-integer numbers
      if (this.forceFloat32) {
        // float 32
        return this.writeU8F32(0xca, object);
      } else {
        // float 64
        return this.writeU8F64(0xcb, object);
      }
    }
  }

  private buildStringHeader(byteLength: number) {
    if (byteLength < 32) {
      // fixstr
      return [0xa0 + byteLength];
    } else if (byteLength < 0x100) {
      // str 8
      return [0xd9, byteLength];
    } else if (byteLength < 0x10000) {
      // str 16
      const bytes = new DataView(new ArrayBuffer(3));
      bytes.setUint8(0, 0xda);
      bytes.setUint16(1, byteLength);
      return new Uint8Array(bytes.buffer);
    } else if (byteLength < 0x100000000) {
      // str 32
      const bytes = new DataView(new ArrayBuffer(5));
      bytes.setUint8(0, 0xdb);
      bytes.setUint32(1, byteLength);
      return new Uint8Array(bytes.buffer);
    } else {
      throw new Error(`Too long string: ${byteLength} bytes in UTF-8`);
    }
  }

  private encodeString(object: string) {
    const maxHeaderSize = 1 + 4;
    const strLength = object.length;

    if (strLength > TEXT_ENCODER_THRESHOLD) {
      const byteLength = utf8Count(object);
      this.ensureBufferSizeToWrite(maxHeaderSize + byteLength);
      const header = this.buildStringHeader(byteLength);
      this.bytes.set(header, 0);
      utf8EncodeTE(object, this.bytes, header.length);
      return this.writeBuffer(byteLength + header.length);
    } else {
      const byteLength = utf8Count(object);
      this.ensureBufferSizeToWrite(maxHeaderSize + byteLength);
      const header = this.buildStringHeader(byteLength);
      this.bytes.set(header, 0);
      utf8EncodeJs(object, this.bytes, header.length);
      return this.writeBuffer(byteLength + header.length);
    }
  }

  private encodeObject(object: unknown, depth: number) {
    // try to encode objects with custom codec first of non-primitives
    const ext = this.extensionCodec.tryToEncode(object, this.context);
    if (ext != null) {
      return this.encodeExtension(ext);
    } else if (Array.isArray(object)) {
      return this.encodeArray(object, depth);
    } else if (ArrayBuffer.isView(object)) {
      return this.encodeBinary(object);
    } else if (typeof object === "object") {
      return this.encodeMap(object as Record<string, unknown>, depth);
    } else {
      // symbol, function and other special object come here unless extensionCodec handles them.
      throw new Error(`Unrecognized object: ${Object.prototype.toString.apply(object)}`);
    }
  }

  private *encodeBinary(object: ArrayBufferView) {
    const size = object.byteLength;
    if (size < 0x100) {
      // bin 8
      yield* this.writeU8U8(0xc4, size);
    } else if (size < 0x10000) {
      // bin 16
      yield* this.writeU8U16(0xc5, size);
    } else if (size < 0x100000000) {
      // bin 32
      yield* this.writeU8U32(0xc6, size);
    } else {
      throw new Error(`Too large binary: ${size}`);
    }
    const bytes = ensureUint8Array(object);
    yield* this.writeU8a(bytes);
  }

  private *encodeArray(object: Array<unknown>, depth: number) {
    const size = object.length;
    if (size < 16) {
      // fixarray
      yield* this.writeU8(0x90 + size);
    } else if (size < 0x10000) {
      // array 16
      yield* this.writeU8U16(0xdc, size);
    } else if (size < 0x100000000) {
      // array 32
      yield* this.writeU8U32(0xdd, size);
    } else {
      throw new Error(`Too large array: ${size}`);
    }
    for (const item of object) {
      yield* this.doEncode(item, depth + 1);
    }
  }

  private countWithoutUndefined(object: Record<string, unknown>, keys: ReadonlyArray<string>): number {
    let count = 0;

    for (const key of keys) {
      if (object[key] !== undefined) {
        count++;
      }
    }

    return count;
  }

  private *encodeMap(object: Record<string, unknown>, depth: number) {
    const keys = Object.keys(object);
    if (this.sortKeys) {
      keys.sort();
    }

    const size = this.ignoreUndefined ? this.countWithoutUndefined(object, keys) : keys.length;

    if (size < 16) {
      // fixmap
      yield* this.writeU8(0x80 + size);
    } else if (size < 0x10000) {
      // map 16
      yield* this.writeU8U16(0xde, size);
    } else if (size < 0x100000000) {
      // map 32
      yield* this.writeU8U32(0xdf, size);
    } else {
      throw new Error(`Too large map object: ${size}`);
    }

    for (const key of keys) {
      const value = object[key];

      if (!(this.ignoreUndefined && value === undefined)) {
        yield* this.encodeString(key);
        yield* this.doEncode(value, depth + 1);
      }
    }
  }

  private *encodeExtension(ext: ExtData) {
    const size = ext.data.length;
    if (size === 1) {
      // fixext 1
      yield* this.writeU8(0xd4);
    } else if (size === 2) {
      // fixext 2
      yield* this.writeU8(0xd5);
    } else if (size === 4) {
      // fixext 4
      yield* this.writeU8(0xd6);
    } else if (size === 8) {
      // fixext 8
      yield* this.writeU8(0xd7);
    } else if (size === 16) {
      // fixext 16
      yield* this.writeU8(0xd8);
    } else if (size < 0x100) {
      // ext 8
      yield* this.writeU8U8(0xc7, size);
    } else if (size < 0x10000) {
      // ext 16
      yield* this.writeU8U16(0xc8, size);
    } else if (size < 0x100000000) {
      // ext 32
      yield* this.writeU8U32(0xc9, size);
    } else {
      throw new Error(`Too large extension object: ${size}`);
    }
    yield* this.writeI8(ext.type);
    yield* this.writeU8a(ext.data);
  }

  private writeU8(value: number) {
    this.view.setUint8(0, value);
    return this.writeBuffer(1);
  }

  private writeU8a(values: ArrayLike<number>) {
    const size = values.length;
    this.ensureBufferSizeToWrite(size);

    this.bytes.set(values, 0);
    return this.writeBuffer(size);
  }

  private writeI8(value: number) {
    this.view.setInt8(0, value);
    return this.writeBuffer(1);
  }

  private writeU16(value: number) {
    this.view.setUint16(0, value);
    return this.writeBuffer(2);
  }

  private writeI16(value: number) {
    this.view.setInt16(0, value);
    return this.writeBuffer(2);
  }

  private writeU32(value: number) {
    this.view.setUint32(0, value);
    return this.writeBuffer(4);
  }

  private writeI32(value: number) {
    this.view.setInt32(0, value);
    return this.writeBuffer(4);
  }

  private writeF32(value: number) {
    this.view.setFloat32(0, value);
    return this.writeBuffer(4);
  }

  private writeF64(value: number) {
    this.view.setFloat64(0, value);
    return this.writeBuffer(8);
  }

  private writeU64(value: number) {
    setUint64(this.view, 0, value);
    return this.writeBuffer(8);
  }

  private writeI64(value: number) {
    setInt64(this.view, 0, value);
    return this.writeBuffer(8);
  }

  private writeU8U8(value: number, value2: number) {
    this.view.setUint8(0, value);
    this.view.setUint8(1, value2);
    return this.writeBuffer(2);
  }

  private writeU8U16(u8: number, u16: number) {
    this.view.setUint8(0, u8);
    this.view.setUint16(1, u16);
    return this.writeBuffer(3);
  }

  private writeU8U32(u8: number, u32: number) {
    this.view.setUint8(0, u8);
    this.view.setUint32(1, u32);
    return this.writeBuffer(5);
  }

  private writeU8U64(u8: number, u64: number) {
    this.view.setUint8(0, u8);
    setUint64(this.view, 1, u64);
    return this.writeBuffer(9);
  }

  private writeU8I8(value: number, value2: number) {
    this.view.setUint8(0, value);
    this.view.setInt8(1, value2);
    return this.writeBuffer(2);
  }

  private writeU8I16(u8: number, i16: number) {
    this.view.setUint8(0, u8);
    this.view.setInt16(1, i16);
    return this.writeBuffer(3);
  }

  private writeU8I32(u8: number, i32: number) {
    this.view.setUint8(0, u8);
    this.view.setInt32(1, i32);
    return this.writeBuffer(5);
  }

  private writeU8I64(u8: number, i64: number) {
    this.view.setUint8(0, u8);
    setInt64(this.view, 1, i64);
    return this.writeBuffer(9);
  }

  private writeU8F32(u8: number, f32: number) {
    this.view.setUint8(0, u8);
    this.view.setFloat32(1, f32);
    return this.writeBuffer(5);
  }

  private writeU8F64(u8: number, f64: number) {
    this.view.setUint8(0, u8);
    this.view.setFloat64(1, f64);
    return this.writeBuffer(9);
  }

  private *writeBuffer(length: number) {
    yield this.bytes.subarray(0, length);
  }
}
