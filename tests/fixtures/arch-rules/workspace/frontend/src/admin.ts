export async function listUsers() {
  return fetch('/admin/users');
}
