// Same-name trap (M3-02-R1): ReplyList's this.fetchReplies() sits in a callback function () {},
// whose `this` is not the component, so it never resolves here by name.
export function fetchReplies(ticketId) {
  return fetch(`/api/v1/tickets/${ticketId}/replies`);
}
