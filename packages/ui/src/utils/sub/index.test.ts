import assert from "node:assert/strict";
import { test } from "node:test";
import { sub } from "./index";

test("sub removes the shared offset", () => {
  assert.equal(sub(8), 3);
  assert.equal(sub(0), -5);
});
