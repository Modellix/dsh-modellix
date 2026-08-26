/** Closed Design RPC budgets shared by the Host encoder and Client decoder. */
export const DESIGN_WIRE_LIMITS = Object.freeze({
  maxFields: 256,
  maxOptions: 256,
  maxResources: 256,
  maxJsonDepth: 10,
  maxJsonNodes: 4_096,
});
