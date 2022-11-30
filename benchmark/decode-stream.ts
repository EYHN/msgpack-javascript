import { encode, decodeStream } from "../src";
import _ from "lodash";
const data = require("./benchmark-from-msgpack-lite-data.json");
const dataX = _.cloneDeep(new Array(100).fill(data));
const encoded = encode(dataX);

console.log("encoded size:", encoded.byteLength);

console.time("decode #1");
for (let i = 0; i < 1000; i++) {
  let pos = 0;
  decodeStream((data) => {
    const end = Math.min(data.length + pos, encoded.length);
    data.set(encoded.subarray(pos, end));
    const length = end - pos;
    pos = end;
    return length;
  });
}
console.timeEnd("decode #1");
