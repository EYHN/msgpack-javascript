// Main Functions:

import { encode, encodeStream } from "./encode";
export { encode, encodeStream };
import type { EncodeOptions } from "./encode";
export type { EncodeOptions };

import { decode, decodeMulti, decodeStream } from "./decode";
export { decode, decodeMulti, decodeStream };
import type { DecodeOptions } from "./decode";
export { DecodeOptions };

import { decodeAsync, decodeArrayStream, decodeMultiStream } from "./decodeAsync";
export { decodeAsync, decodeArrayStream, decodeMultiStream };

import { Decoder, DataViewIndexOutOfBoundsError } from "./Decoder";
import { DecodeError } from "./DecodeError";
export { Decoder, DecodeError, DataViewIndexOutOfBoundsError };

import { Encoder } from "./Encoder";
export { Encoder };

// Utilitiies for Extension Types:

import { ExtensionCodec } from "./ExtensionCodec";
export { ExtensionCodec };
import type { ExtensionCodecType, ExtensionDecoderType, ExtensionEncoderType } from "./ExtensionCodec";
export type { ExtensionCodecType, ExtensionDecoderType, ExtensionEncoderType };
import { ExtData } from "./ExtData";
export { ExtData };

import {
  EXT_TIMESTAMP,
  encodeDateToTimeSpec,
  encodeTimeSpecToTimestamp,
  decodeTimestampToTimeSpec,
  encodeTimestampExtension,
  decodeTimestampExtension,
} from "./timestamp";
export {
  EXT_TIMESTAMP,
  encodeDateToTimeSpec,
  encodeTimeSpecToTimestamp,
  decodeTimestampToTimeSpec,
  encodeTimestampExtension,
  decodeTimestampExtension,
};
