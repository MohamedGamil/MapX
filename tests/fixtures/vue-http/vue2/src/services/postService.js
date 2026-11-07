import Api from '@/api/Api';
import { LEGACY_ITEMS } from '@/api/constants';

const api = Api();

export default {
  list() { return Api().get('posts'); } /* L01 */,
  search(body) { return api.post('posts/search', body); } /* L02 */,
  legacy() { return api.get(LEGACY_ITEMS); } /* L03 */,
  legacyItem(id) { return api.get(`${LEGACY_ITEMS}/${id}`); } /* L04 */,
  users() {
    return api.get( /* L05 */
      'v1/users'
    );
  },
  directory(admin) { return api.get(admin ? 'v1/users' : 'v1/people'); } /* L06 L07 */,
  dup() { return api.get('dup'); } /* L08 */,
  missing() { return api.get('nope/missing'); } /* L09 */,
};
