import assert from "node:assert";
import { compute } from "./logic.js";

// add(value) = value + 12
assert.strictEqual(compute(8), 20);
assert.strictEqual(compute(0), 12);

console.log("web logic unit test: OK");
