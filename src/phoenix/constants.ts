/** Leaf module (no imports) so config, profile, and Phoenix code can all reference it without cycles. */
export const PHOENIX_SETUP_URL = "https://arize.com/docs/phoenix/environments"
export const PHOENIX_SETUP_HINT = `Phoenix is not configured. Run \`pxt init\` to add a Phoenix endpoint, or see ${PHOENIX_SETUP_URL} to self-host or use Phoenix Cloud.`
