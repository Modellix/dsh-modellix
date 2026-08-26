/** Closed Design RPC budgets shared by the Host encoder and Client decoder. */
export const DESIGN_WIRE_LIMITS = Object.freeze({
  maxFields: 256,
  maxOptions: 256,
  maxResources: 256,
  maxJsonBytes: 256 * 1024,
  maxJsonDepth: 10,
  maxJsonNodes: 4_096,
});

/** Shape consumed by the non-recursive JSON boundary inspector. */
export const DESIGN_JSON_LIMITS = Object.freeze({
  maxBytes: DESIGN_WIRE_LIMITS.maxJsonBytes,
  maxDepth: DESIGN_WIRE_LIMITS.maxJsonDepth,
  maxNodes: DESIGN_WIRE_LIMITS.maxJsonNodes,
});
