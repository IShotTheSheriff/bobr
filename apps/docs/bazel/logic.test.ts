import assert from "node:assert";
import { compute } from "./logic.js";

// sub(value) = value - 5
assert.strictEqual(compute(10), 5);
assert.strictEqual(compute(5), 0);

console.log("docs logic unit test: OK");
