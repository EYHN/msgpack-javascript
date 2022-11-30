#!/usr/bin/env deno run
/* eslint-disable no-console */
import * as msgpack from "https://cdn.jsdelivr.net/npm/@eyhn/msgpack-stream/mod.ts";

console.log(msgpack.decode(msgpack.encode("Hello, world!")));
