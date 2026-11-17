/** Only the most recent, still-connected editor host may mount after loading.
 * Failed imports can be retried; a successful module is shared by later views. */
export function createLazyEditor(load) {
  let pending, generation = 0;
  return {
    cancel() { generation++; },
    async mount(parent, ready, failed) {
      const current = ++generation;
      try {
        pending ??= load().catch(error => { pending = null; throw error; });
        const module = await pending;
        if (current === generation && parent.isConnected) ready(module.createJSONEditor);
      } catch (error) {
        if (current === generation && parent.isConnected) failed(error);
      }
    }
  };
}
