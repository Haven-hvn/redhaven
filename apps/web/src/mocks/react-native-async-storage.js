/** Browser stub for an optional WalletConnect peer: localStorage-backed, never throws. */
const mem = new Map()
const storage = {
  async getItem(k) {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : mem.get(k) ?? null } catch { return mem.get(k) ?? null }
  },
  async setItem(k, v) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); else mem.set(k, v) } catch { mem.set(k, v) }
  },
  async removeItem(k) {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); else mem.delete(k) } catch { mem.delete(k) }
  },
}
export default storage
