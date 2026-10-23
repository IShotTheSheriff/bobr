// Mirrors what apps/web actually does on its home page: it imports `add` from
// @repo/ui and computes a result. This Bazel-built module depends ONLY on the
// `add` leaf target — so a change to `sub/` can never invalidate it.
import { add } from "../../../packages/ui/src/utils/add/index.js";

export const compute = (value: number): number => add(value);
