// Same-name trap (M3-04): exports named like the functions SettingsPanel and TicketDetail destructure
// from their composables. Those calls resolve to the composables' files, never here.
export function persist(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function addReply(ticketId, body) {
  return fetch(`/api/v1/tickets/${ticketId}/replies`, { method: 'POST', body: JSON.stringify({ body }) });
}
