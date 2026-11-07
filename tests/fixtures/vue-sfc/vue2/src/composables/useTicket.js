import { ref } from 'vue';

export function useTicket(id) {
  const ticket = ref(null);

  fetch(`/api/tickets/${id}`)
    .then((response) => response.json())
    .then((data) => {
      ticket.value = data;
    });

  function addReply(body) {
    return fetch(`/api/tickets/${id}/replies`, { method: 'POST', body: JSON.stringify({ body }) });
  }

  return { ticket, addReply };
}
