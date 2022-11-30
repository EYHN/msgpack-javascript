import { encode, decodeStream } from "../src";
import _ from "lodash";
const data = require("./benchmark-from-msgpack-lite-data.json");
const dataX = _.cloneDeep(new Array(100).fill(data));
const encoded = encode(dataX);

console.log("encoded size:", encoded.byteLength);

(async () => {
  console.time("decode #1");

  for (let i = 0; i < 1000; i++) {
    let pos = 0;

    await decodeStream(
      (async function* () {
        const readLength = 2048;
        while (pos < encoded.length) {
          const result = encoded.subarray(pos, pos + readLength);
          pos += readLength;
          yield result;
        }
      })(),
    );
  }

  console.timeEnd("decode #1");
})();
