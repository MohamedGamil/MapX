import Api from '@/api/Api';

// M2-04-R2: each call sees the constant declared in its own scope.
const path = 'posts';

export function loadTags() {
  const url = 'tags';
  return Api().get(url); /* L33 */
}

export function loadStatuses() {
  const url = 'statuses';
  return Api().get(url); /* L34 */
}

export function loadPosts() {
  return Api().get(path); /* L35 */
}

export function loadHealth() {
  const path = 'health';
  return Api().get(path); /* L38 */
}
