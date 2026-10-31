import Api from '@/api/Api';

// M2-06-R1: a URL with no literal path segment is no evidence for any route.
export function page(endpoint, n) {
  return Api().get(`${endpoint}?page=${n}`); /* L39 */
}

export function byId(base, id) {
  return Api().get(`${base}/${id}`); /* L40 */
}
