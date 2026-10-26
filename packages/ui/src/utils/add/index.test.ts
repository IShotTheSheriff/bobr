import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "./index";

test("add applies the shared offset", () => {
  assert.equal(add(8), 20);
  assert.equal(add(0), 12);
});
