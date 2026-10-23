// Mirrors what apps/docs actually does: it imports `sub` from @repo/ui. This
// Bazel-built module depends ONLY on the `sub` leaf target — so a change to
// `add/` can never invalidate it.
import { sub } from "../../../packages/ui/src/utils/sub/index.js";

export const compute = (value: number): number => sub(value);
