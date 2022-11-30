import { encodeStream, decode } from "../src";
import _ from "lodash";

const data = require("./benchmark-from-msgpack-lite-data.json");
const dataX = _.cloneDeep(new Array(100).fill(data));

const bytes = new Uint8Array(new ArrayBuffer(102400));
bytes.fill(0);

console.time("encode #1");
for (let i = 0; i < 1000; i++) {
  let pos = 0;
  encodeStream(dataX, (buffer) => {
    bytes.set(buffer, pos);
    pos += buffer.length;
  });
}

console.timeEnd("encode #1");