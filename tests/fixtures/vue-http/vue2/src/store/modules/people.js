import Api from '@/api/Api';

export default {
  namespaced: true,
  actions: {
    FETCH() { return Api().get('v1/people'); } /* L13 */,
    SHOW(_, id) { return Api().get(`v1/people/${id}`); } /* L14 */,
    SAVE(_, person) { return Api().put(`v1/people/${person.id}`, person); } /* L15 */,
    REMOVE(_, id) { return Api().delete(`v1/people/${id}`); } /* L16 */,
  },
};
