import { Encoder } from "./Encoder";
import type { ExtensionCodecType } from "./ExtensionCodec";
import type { ContextOf, SplitUndefined } from "./context";
import { StreamEncoder } from "./StreamEncoder";

export type EncodeOptions<ContextType = undefined> = Partial<
  Readonly<{
    extensionCodec: ExtensionCodecType<ContextType>;

    /**
     * The maximum depth in nested objects and arrays.
     *
     * Defaults to 100.
     */
    maxDepth: number;

    /**
     * The initial size of the internal buffer.
     *
     * Defaults to 2048.
     */
    initialBufferSize: number;

    /**
     * The size of the stream buffer.
     *
     * Defaults to 2048.
     */
    streamBufferSize: number;

    /**
     * If `true`, the keys of an object is sorted. In other words, the encoded
     * binary is canonical and thus comparable to another encoded binary.
     *
     * Defaults to `false`. If enabled, it spends more time in encoding objects.
     */
    sortKeys: boolean;
    /**
     * If `true`, non-integer numbers are encoded in float32, not in float64 (the default).
     *
     * Only use it if precisions don't matter.
     *
     * Defaults to `false`.
     */
    forceFloat32: boolean;

    /**
     * If `true`, an object property with `undefined` value are ignored.
     * e.g. `{ foo: undefined }` will be encoded as `{}`, as `JSON.stringify()` does.
     *
     * Defaults to `false`. If enabled, it spends more time in encoding objects.
     */
    ignoreUndefined: boolean;

    /**
     * If `true`, integer numbers are encoded as floating point numbers,
     * with the `forceFloat32` option taken into account.
     *
     * Defaults to `false`.
     */
    forceIntegerToFloat: boolean;
  }>
> &
  ContextOf<ContextType>;

const defaultEncodeOptions: EncodeOptions = {};

/**
 * It encodes `value` in the MessagePack format and
 * returns a byte buffer.
 *
 * The returned buffer is a slice of a larger `ArrayBuffer`, so you have to use its `#byteOffset` and `#byteLength` in order to convert it to another typed arrays including NodeJS `Buffer`.
 */
export function encode<ContextType = undefined>(
  value: unknown,
  options: EncodeOptions<SplitUndefined<ContextType>> = defaultEncodeOptions as any,
): Uint8Array {
  const encoder = new Encoder(
    options.extensionCodec,
    (options as typeof options & { context: any }).context,
    options.maxDepth,
    options.initialBufferSize,
    options.sortKeys,
    options.forceFloat32,
    options.ignoreUndefined,
    options.forceIntegerToFloat,
  );
  return encoder.encodeSharedRef(value);
}

export function encodeStream<ContextType = undefined>(
  value: unknown,
  options: EncodeOptions<SplitUndefined<ContextType>> = defaultEncodeOptions as any,
): Iterable<Uint8Array> {
  const encoder = new StreamEncoder(
    options.extensionCodec,
    (options as typeof options & { context: any }).context,
    options.maxDepth,
    options.streamBufferSize,
    options.sortKeys,
    options.forceFloat32,
    options.ignoreUndefined,
    options.forceIntegerToFloat,
  );
  return encoder.encode(value);
}
