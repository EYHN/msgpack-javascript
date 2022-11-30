import { encodeStream } from "../src";
import _ from "lodash";
import { Writable } from "stream";
import { pipeline } from "stream/promises";

const data = require("./benchmark-from-msgpack-lite-data.json");
const dataX = _.cloneDeep(new Array(100).fill(data));

(async () => {
  console.time("encode #1");

  for (let i = 0; i < 1000; i++) {
    const stream = encodeStream(dataX);
    await pipeline(
      stream,
      new Writable({
        write(_chunk, _encoding, cb) {
          cb();
        },
      }),
    );
  }

  console.timeEnd("encode #1");
})();
