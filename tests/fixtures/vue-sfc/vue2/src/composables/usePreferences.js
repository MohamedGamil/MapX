import { reactive } from 'vue';

export function usePreferences(userId) {
  const prefs = reactive({ compact: false });

  async function persist() {
    await fetch(`/api/users/${userId}/preferences`, {
      method: 'PUT',
      body: JSON.stringify({ compact: prefs.compact }),
    });
  }

  return { prefs, persist };
}
