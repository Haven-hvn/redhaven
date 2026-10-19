/**
 * Ambient declarations for peer bundles that exist only in a dsh profile's
 * node_modules, not in this workspace. Runtime shapes are narrowed at the
 * call site (`as unknown as { ... }`), so these stay loose.
 */

declare module 'dsh-wallet' {}

declare module 'dsh-board' {}
