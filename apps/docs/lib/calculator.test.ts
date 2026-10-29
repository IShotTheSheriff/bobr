import assert from "node:assert/strict";
import { test } from "node:test";
import { calculate } from "./calculator";

test("the calculator uses the shared sub utility", () => {
  assert.equal(
    calculate(50),
    45,
    "the home page shows 45 when the slider is at 50",
  );
});
